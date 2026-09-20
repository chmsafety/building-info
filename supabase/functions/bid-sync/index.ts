// 나라장터(조달청) 용역 입찰공고 중 '등록된 빌딩과 연결되는 공고'만 찾아 저장합니다.
// 필요한 비밀값: G2B_API_KEY (없으면 BLD_API_KEY 사용 — 공공데이터포털 같은 계정의 일반 인증키)
// 공공데이터포털에서 활용신청 필요: '조달청_나라장터 입찰공고정보서비스', '조달청_나라장터 낙찰정보서비스'
// 동작(POST JSON): probe / run {day, fmOnly} / winners / daily(자동)
// 2026-09-21: ① 발주기관(수요기관) 이름으로도 연결  ② 낙찰자를 '관리사 검토 대기'로 자동 등록
import { createClient } from "npm:@supabase/supabase-js@2";

function envKey(legacy: string, modern: string): string {
  const v = Deno.env.get(legacy);
  if (v) return v;
  try { const m = JSON.parse(Deno.env.get(modern) ?? "{}"); return String(Object.values(m)[0] ?? ""); } catch { return ""; }
}
const ANON_KEY = envKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
const SERVICE_KEY = envKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
const ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

let KEY = Deno.env.get("G2B_API_KEY") || Deno.env.get("BLD_API_KEY") || "";
if (KEY.includes("%")) { try { KEY = decodeURIComponent(KEY); } catch { /* keep */ } }
const BID_API = "apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoServcPPSSrch";
const WIN_API = "apis.data.go.kr/1230000/as/ScsbidInfoService/getScsbidListSttusServc";
let calls = 0;

// 시설관리 관련 공고만 (공고명 기준)
const FM_WORDS = ["시설관리", "시설물관리", "시설유지", "종합관리", "통합관리", "위탁관리", "건물관리", "청사관리", "사옥관리", "빌딩관리",
  "관리용역", "운영관리", "유지관리", "시설운영", "청소", "미화", "환경관리", "경비", "보안", "방호", "안내", "소방", "승강기", "엘리베이터",
  "전기안전", "전기설비", "기계설비", "설비관리", "냉난방", "공조", "주차관리", "방재", "fm"];
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/\(주\)|㈜|주식회사/g, "").replace(/[\s·.,\-_()[\]{}"'「」『』<>]/g, "");
const isFm = (title: string) => { const t = norm(title); return FM_WORDS.some((w) => t.includes(w)); };

// 빌딩 이름 → 공고명에서 찾을 검색어. 주소처럼 생긴 이름·너무 짧거나 흔한 이름은 빼고, 직접 넣은 검색어는 그대로.
const GENERIC = new Set(["빌딩", "타워", "센터", "사옥", "본관", "별관", "청사", "본사", "오피스", "플라자", "스퀘어", "타워a", "타워b"]);
function keywordsOf(b: any): string[] {
  const out = new Set<string>();
  const nm = String(b.name ?? "").replace(/\(.*?\)/g, " ").trim();
  const looksAddr = /\d+\s*(길|로|번지)|(로|길)\s*\d+|^\S+(동|가)\s*\d/.test(nm);
  const k = norm(nm);
  if (!looksAddr && k.length >= 3 && !GENERIC.has(k)) out.add(k);
  for (const x of String(b.bid_keywords ?? "").split(/[,\n;]/)) { const y = norm(x); if (y.length >= 2) out.add(y); }
  return [...out];
}
// 발주기관 이름: 빌딩별로 직접 넣은 '발주기관명'(bid_orgs) + 공공건물은 빌딩명·소유주가 기관명과 같을 때
const SITE = /청사|사옥|본사|본부|본원|회관|센터|타워|빌딩|별관|본관|건물/;
function orgMatch(b: any, it: any, title: string): string | null {
  const orgs = [norm(it.dminsttNm), norm(it.ntceInsttNm)].filter((x) => x.length >= 4);
  if (!orgs.length) return null;
  for (const x of String(b.bid_orgs ?? "").split(/[,\n;]/)) {
    const k = norm(x); if (k.length < 3) continue;
    if (orgs.some((o) => o.includes(k))) return "기관:" + k;
  }
  if (b.is_public && SITE.test(title)) {
    const nm = norm(String(b.name ?? "").replace(/\(.*?\)/g, " ")), own = norm(b.owner);
    const d = norm(it.dminsttNm);
    if (d.length >= 5 && (nm === d || own === d || (nm.startsWith(d) && nm.length - d.length <= 6))) return "기관:" + d;
  }
  return null;
}
async function loadBuildings(db: any) {
  let r = await db.from("buildings").select("id, name, bid_keywords, bid_orgs, is_public, owner, fm, staff");
  if (r.error) r = await db.from("buildings").select("id, name, bid_keywords, fm, staff");   // 10_sales_backup.sql 실행 전
  return r.data ?? [];
}

const ymd = (d: Date) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
const kst = (s: any) => { const t = String(s ?? "").trim(); if (!t) return null; const m = t.match(/^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2})?:?(\d{2})?/); if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:00+09:00`; };
const num = (v: any) => { const n = +String(v ?? "").replace(/,/g, ""); return isFinite(n) && String(v ?? "").trim() !== "" ? n : null; };

async function call(host: string, params: Record<string, string>) {
  const q = new URLSearchParams({ serviceKey: KEY, type: "json", ...params });
  let t = "";
  for (let attempt = 0; ; attempt++) {
    calls++;
    try {
      const r = await fetch(`https://${host}?${q}`, { signal: AbortSignal.timeout(25000) }).catch(() => fetch(`http://${host}?${q}`, { signal: AbortSignal.timeout(25000) }));
      t = await r.text();
    } catch (e) { if (attempt < 2) { await new Promise((s) => setTimeout(s, 1500)); continue; } throw new Error("나라장터 API 연결 실패: " + (e as Error).message); }
    if (attempt < 3 && /PER_SECOND|초당/i.test(t)) { await new Promise((s) => setTimeout(s, 800 * (attempt + 1))); continue; }
    break;
  }
  let j: any;
  try { j = JSON.parse(t); } catch { throw new Error("API 응답 오류: " + t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180)); }
  const eh = j?.OpenAPI_ServiceResponse?.cmmMsgHeader ?? j?.["nkoneps.com.response.ResponseError"]?.header;
  if (eh) throw new Error(`API 오류: ${eh.returnAuthMsg ?? eh.errMsg ?? eh.resultMsg ?? "알 수 없음"}`);
  const h = j?.response?.header;
  if (h && h.resultCode && h.resultCode !== "00") throw new Error(`API 오류 ${h.resultCode}: ${h.resultMsg}`);
  const body = j?.response?.body ?? {};
  let items = body?.items?.item ?? body?.items ?? [];
  if (!Array.isArray(items)) items = items ? [items] : [];
  return { total: +body.totalCount || 0, items };
}
async function dayNotices(day: string) {   // 하루치 용역 공고 전부
  const rows = 500, out: any[] = [];
  for (let p = 1; p <= 20; p++) {
    const r = await call(BID_API, { inqryDiv: "1", inqryBgnDt: day + "0000", inqryEndDt: day + "2359", pageNo: String(p), numOfRows: String(rows) });
    out.push(...r.items);
    if (p * rows >= r.total || !r.items.length) break;
  }
  return out;
}

async function syncDay(db: any, day: string, fmOnly: boolean, mode: string) {
  const blds = await loadBuildings(db);
  const kw = blds.map((b: any) => ({ b, id: b.id, ks: keywordsOf(b) }));
  const items = await dayNotices(day);
  const found = new Map<string, { it: any; links: { id: string; k: string }[] }>();
  for (const it of items) {
    const title = String(it.bidNtceNm ?? "");
    if (fmOnly && !isFm(title)) continue;
    const t = norm(title);
    const links: { id: string; k: string }[] = [];
    for (const x of kw) {
      const k = x.ks.find((y: string) => t.includes(y)) ?? orgMatch(x.b, it, title);
      if (k) links.push({ id: x.id, k });
    }
    if (!links.length) continue;
    const no = String(it.bidNtceNo ?? "").trim(); if (!no) continue;
    const prev = found.get(no);
    if (!prev || String(it.bidNtceOrd ?? "") >= String(prev.it.bidNtceOrd ?? "")) found.set(no, { it, links });
  }
  let newLinks = 0;
  if (found.size) {
    const nos = [...found.keys()];
    const { data: ex } = await db.from("bids").select("bid_no, bid_ord").in("bid_no", nos);
    const exOrd = new Map((ex ?? []).map((x: any) => [x.bid_no, String(x.bid_ord ?? "")]));
    const rows = [];
    for (const [no, { it }] of found) {
      if (exOrd.has(no) && String(it.bidNtceOrd ?? "") < (exOrd.get(no) as string)) continue;   // 더 최근 차수가 이미 있음
      rows.push({
        bid_no: no, bid_ord: String(it.bidNtceOrd ?? ""), title: String(it.bidNtceNm ?? "").slice(0, 300),
        org: it.ntceInsttNm ?? null, demand_org: it.dminsttNm ?? null, kind: it.ntceKindNm ?? null,
        contract_method: it.cntrctCnclsMthdNm ?? null, notice_at: kst(it.bidNtceDt), close_at: kst(it.bidClseDt), open_at: kst(it.opengDt),
        price: num(it.presmptPrce), budget: num(it.asignBdgtAmt), url: it.bidNtceDtlUrl || it.bidNtceUrl || null, updated_at: new Date().toISOString(),
      });
    }
    if (rows.length) { const { error } = await db.from("bids").upsert(rows, { onConflict: "bid_no" }); if (error) throw new Error("저장 오류: " + error.message); }
    const { data: exl } = await db.from("bid_links").select("bid_no, building_id").in("bid_no", nos);
    const have = new Set((exl ?? []).map((x: any) => x.bid_no + "|" + x.building_id));
    const lrows = [];
    for (const [no, { links }] of found) for (const l of links) if (!have.has(no + "|" + l.id)) lrows.push({ bid_no: no, building_id: l.id, keyword: l.k });
    if (lrows.length) { const { error } = await db.from("bid_links").insert(lrows); if (error) throw new Error("연결 저장 오류: " + error.message); newLinks = lrows.length; }
  }
  await db.from("bid_runs").insert({ mode, day, scanned: items.length, matched: found.size, new_links: newLinks, calls });
  return { day, scanned: items.length, matched: found.size, newLinks, keywords: kw.filter((x: any) => x.ks.length).length };
}

// 공고명으로 어떤 역할의 계약인지 추정 → 관리사 검토 대기의 역할 표기
function roleOf(title: string): string | null {
  const t = norm(title);
  if (/시설관리|시설물관리|시설유지|시설운영|종합관리|통합관리|위탁관리|건물관리|청사관리|사옥관리|빌딩관리|설비관리|기계설비|운영관리|fm/.test(t)) return "";
  if (/청소|미화|환경관리/.test(t)) return "(미화)";
  if (/경비|보안|방호|경호/.test(t)) return "(보안)";
  if (/안내/.test(t)) return "(안내)";
  return null;   // 승강기·소방·전기 점검 같은 단일 공종은 관리회사로 올리지 않음
}
const coKey = (s: string) => String(s ?? "").replace(/\s|\(주\)|㈜|주식회사|\((보안|미화|안내|PM|pm)\)/g, "").toLowerCase();
const cleanCo = (s: string) => String(s ?? "").replace(/주식회사|\(주\)|㈜/g, " ").replace(/\s+/g, " ").trim();
const ROLE_KEY: Record<string, string> = { "": "facility", "(미화)": "cleaning", "(보안)": "security", "(안내)": "other" };
const wonTxt = (v: any) => { v = +v; if (!v) return ""; return v >= 1e8 ? (v / 1e8).toFixed(v >= 1e9 ? 0 : 1) + "억원" : Math.round(v / 1e4).toLocaleString("ko-KR") + "만원"; };

// 낙찰자가 나온 연결 공고 → fm_suggestions(검토 대기)에 한 번씩 올림. 같은 빌딩·회사 제안이 이미 있으면(무시한 것 포함) 다시 올리지 않음.
async function suggestFromWinners(db: any) {
  const { data: won } = await db.from("bids").select("bid_no, title, winner, winner_amt, open_at, demand_org, org, url, kind")
    .not("winner", "is", null).order("open_at", { ascending: false }).limit(500);
  if (!won?.length) return 0;
  const { data: links } = await db.from("bid_links").select("bid_no, building_id, hidden").in("bid_no", won.map((x: any) => x.bid_no));
  const L = (links ?? []).filter((x: any) => !x.hidden);
  if (!L.length) return 0;
  const bIds = [...new Set(L.map((x: any) => x.building_id))];
  const [{ data: sugs }, { data: blds }] = await Promise.all([
    db.from("fm_suggestions").select("building_id, company").in("building_id", bIds),
    db.from("buildings").select("id, fm, staff").in("id", bIds)]);
  const seen = new Set((sugs ?? []).map((s: any) => s.building_id + "|" + coKey(s.company)));
  const bmap = new Map((blds ?? []).map((b: any) => [b.id, b]));
  const latest = new Map<string, any>();   // 빌딩·역할별로 가장 최근 낙찰만
  for (const w of won) {
    if (/취소/.test(w.kind ?? "")) continue;
    const role = roleOf(w.title); if (role === null) continue;
    for (const l of L.filter((x: any) => x.bid_no === w.bid_no)) {
      const k = l.building_id + "|" + role;
      if (!latest.has(k)) latest.set(k, { w, bid: l.building_id, role });
    }
  }
  const rows = [];
  for (const { w, bid, role } of latest.values()) {
    const co = cleanCo(w.winner); if (!co) continue;
    if (seen.has(bid + "|" + coKey(co))) continue;
    const b: any = bmap.get(bid) ?? {};
    const rk = ROLE_KEY[role];
    const cur = rk === "facility" ? b.fm?.company : b.staff?.[rk]?.company;
    if (cur && coKey(cur) === coKey(co)) continue;   // 이미 같은 회사가 입력돼 있음
    const d = w.open_at ? String(w.open_at).slice(0, 10).replace(/-/g, ".") : "";
    rows.push({ building_id: bid, company: (co + role).slice(0, 120), source_url: w.url ?? null, confidence: "상",
      evidence: ["나라장터 낙찰", w.title, w.demand_org || w.org, d ? "개찰 " + d : "", w.winner_amt ? "낙찰금액 " + wonTxt(w.winner_amt) : ""].filter(Boolean).join(" · ").slice(0, 900) });
    seen.add(bid + "|" + coKey(co));
  }
  if (rows.length) { const { error } = await db.from("fm_suggestions").insert(rows); if (error) throw new Error("검토 대기 저장 오류: " + error.message); }
  return rows.length;
}

// 개찰이 끝난 공고의 낙찰자 확인 (낙찰정보서비스)
async function winners(db: any, limit = 25) {
  const now = new Date();
  const { data } = await db.from("bids").select("bid_no, notice_at, open_at, winner_checked_at")
    .is("winner", null).lt("open_at", now.toISOString()).order("open_at", { ascending: false }).limit(300);
  const pend = (data ?? []).filter((b: any) => !b.winner_checked_at || now.getTime() - new Date(b.winner_checked_at).getTime() > 20 * 3600e3);
  const todo = pend.slice(0, limit);
  let got = 0, err: string | null = null;
  for (const b of todo) {
    const from = b.notice_at ? new Date(b.notice_at) : new Date(now.getTime() - 60 * 864e5);
    try {
      const r = await call(WIN_API, { inqryDiv: "4", bidNtceNo: b.bid_no, inqryBgnDt: ymd(from) + "0000", inqryEndDt: ymd(now) + "2359", pageNo: "1", numOfRows: "10" });
      const w = r.items.find((x: any) => x.bidwinnrNm);
      const upd: any = { winner_checked_at: now.toISOString() };
      if (w) { Object.assign(upd, { winner: String(w.bidwinnrNm).slice(0, 120), winner_bizno: w.bidwinnrBizno ?? null, winner_amt: num(w.sucsfbidAmt), winner_rate: num(w.sucsfbidRate) }); got++; }
      await db.from("bids").update(upd).eq("bid_no", b.bid_no);
    } catch (e) { err = (e as Error).message; if (/SERVICE|등록되지|인증|LIMITED|한도/i.test(err)) break; }
  }
  let suggested = 0;
  try { suggested = await suggestFromWinners(db); } catch (e) { err = err ?? (e as Error).message; }
  return { checked: todo.length, got, remain: Math.max(0, pend.length - todo.length), suggested, err };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!;
  let b: any = {};
  try { b = await req.json(); } catch { /* empty */ }
  const db = createClient(url, SERVICE_KEY, { auth: { persistSession: false } });
  if (b.action === "daily") {
    // 매일 자동 확인(pg_cron)은 로그인 없이 부름. 어제·오늘 공고만 다시 읽는 일이라 정보가 새지 않고,
    // 남용을 막으려고 3시간 안에 이미 돌았으면 건너뜀.
    const { data: lastRun } = await db.from("bid_runs").select("at").eq("mode", "daily").order("at", { ascending: false }).limit(1);
    if (lastRun?.[0] && Date.now() - new Date(lastRun[0].at).getTime() < 3 * 3600e3) return json({ ok: true, skipped: "recent" });
  } else {
    const caller = createClient(url, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: role } = await caller.rpc("my_role");
    if (role !== "admin") return json({ error: "관리자만 쓸 수 있어요." }, 403);
  }
  if (!KEY) return json({ error: "G2B_API_KEY(또는 BLD_API_KEY) 비밀값이 없어요." }, 400);
  calls = 0;
  try {
    if (b.action === "probe") {
      const day = ymd(new Date(Date.now() - 864e5));
      const r = await call(BID_API, { inqryDiv: "1", inqryBgnDt: day + "0000", inqryEndDt: day + "2359", pageNo: "1", numOfRows: "5" });
      const s = r.items[0] ?? {};
      const blds = await loadBuildings(db);
      return json({ ok: true, day, total: r.total, sample: { 공고명: s.bidNtceNm, 수요기관: s.dminsttNm, 마감: s.bidClseDt },
        keywords: blds.filter((x: any) => keywordsOf(x).length).length, orgs: blds.filter((x: any) => x.bid_orgs || x.is_public).length, buildings: blds.length });
    }
    if (b.action === "run") {
      const day = String(b.day ?? ""); if (!/^\d{8}$/.test(day)) return json({ error: "day 형식은 YYYYMMDD" }, 400);
      return json({ ok: true, ...(await syncDay(db, day, b.fmOnly !== false, "manual")), calls });
    }
    if (b.action === "winners") return json({ ok: true, ...(await winners(db, Math.min(60, +b.limit || 25))), calls });
    if (b.action === "daily") {   // 어제·오늘 공고 + 낙찰자 확인
      const res = [];
      for (const d of [ymd(new Date(Date.now() - 864e5)), ymd(new Date())]) {
        try { res.push(await syncDay(db, d, true, "daily")); }
        catch (e) { await db.from("bid_runs").insert({ mode: "daily", day: d, calls, note: String((e as Error).message).slice(0, 300) }); res.push({ day: d, error: String((e as Error).message) }); }
      }
      const w = await winners(db, 30).catch((e) => ({ err: String(e) }));
      return json({ ok: true, days: res, winners: w, calls });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e), calls }, 502);
  }
});
