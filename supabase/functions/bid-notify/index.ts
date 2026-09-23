// 나라장터 입찰 문자 알림 (2026-09-23)
// 등록 빌딩과 연결된 입찰공고가 ① 새로 잡히거나(new) ② 마감이 임박하거나(due) ③ 낙찰자가 확인되면(win)
// sms_recipients 의 휴대폰으로 솔라피 문자를 보냅니다. 같은 공고·같은 종류는 bid_notices 로 한 번만.
// 동작(POST JSON):
//   run                 — 알릴 것을 찾아 보냄. 로그인 없이도 부를 수 있음(pg_cron). 이미 알린 건 다시 안 보냄.
//   preview             — (관리자) 지금 보내면 누구에게 어떤 글이 가는지만 보여 줌
//   status              — (관리자) 솔라피 키 설정 여부·발신번호(가림)·잔액
//   config {api_key, api_secret, sender} — (관리자) 솔라피 키 저장. 빈 칸은 그대로 둠
//   test {ids?}         — (관리자) 받는 사람에게 시험 문자
// Verify JWT 는 끄고 배포(관리자 확인은 함수 안에서 함).
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

const DAY = 864e5;
const WIN_WINDOW = 45 * DAY;      // 개찰이 이보다 오래된 낙찰은 알리지 않음(1년치 가져오기 때 옛 낙찰이 쏟아지지 않게)
const MAX_BYTES = 2000;           // LMS 본문 한도
const SMS_BYTES = 90;             // 이하면 단문(SMS)

// ---------------- 글 만들기 (순수 함수 — 시험하기 쉽게) ----------------
export const bytesOf = (s: string) => { let n = 0; for (const ch of s) n += ch.codePointAt(0)! <= 0x7f ? 1 : 2; return n; };
const cut = (s: string, n: number) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return [...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s; };
const WD = ["일", "월", "화", "수", "목", "금", "토"];
export function kstTxt(t: string | null): string {
  if (!t) return "";
  const d = new Date(new Date(t).getTime() + 9 * 3600e3);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})${hm === "00:00" ? "" : " " + hm}`;
}
export function dday(end: string, now: number): string {
  const k = (x: number) => Math.floor((x + 9 * 3600e3) / DAY);   // 한국 날짜 기준
  const n = k(new Date(end).getTime()) - k(now);
  return n <= 0 ? "오늘 마감" : "D-" + n;
}
export const won = (v: any) => { v = +v; if (!v) return ""; return v >= 1e8 ? (v / 1e8).toFixed(v >= 1e9 ? 0 : 1) + "억원" : Math.round(v / 1e4).toLocaleString("ko-KR") + "만원"; };
const endOf = (b: any) => b.close_at || b.open_at || null;
const isCanceled = (b: any) => /취소/.test(b.kind ?? "");

export type Item = { bid: any; names: string[] };
export type Plan = { news: Item[]; dues: Item[]; wins: Item[] };

// 연결 목록 + 이미 알린 목록 → 이번에 알릴 것
export function makePlan(links: any[], sent: Set<string>, dueDays: number, now: number): Plan {
  const by = new Map<string, Item>();
  for (const l of links) {
    if (l.hidden || !l.bids) continue;
    const it = by.get(l.bid_no) ?? { bid: l.bids, names: [] };
    const nm = l.buildings?.name; if (nm && !it.names.includes(nm)) it.names.push(nm);
    by.set(l.bid_no, it);
  }
  const news: Item[] = [], dues: Item[] = [], wins: Item[] = [];
  for (const [no, it] of by) {
    const b = it.bid; if (isCanceled(b)) continue;
    const end = endOf(b), open = !!end && new Date(end).getTime() > now;
    if (open && !sent.has(no + "|new")) news.push(it);
    else if (open && !sent.has(no + "|due") && new Date(end).getTime() - now <= dueDays * DAY) dues.push(it);
    const oa = b.open_at || b.close_at;
    if (b.winner && !sent.has(no + "|win") && (!oa || now - new Date(oa).getTime() <= WIN_WINDOW)) wins.push(it);
  }
  const byEnd = (a: Item, c: Item) => new Date(endOf(a.bid) ?? 0).getTime() - new Date(endOf(c.bid) ?? 0).getTime();
  news.sort(byEnd); dues.sort(byEnd);
  wins.sort((a, c) => new Date(c.bid.open_at ?? 0).getTime() - new Date(a.bid.open_at ?? 0).getTime());
  return { news, dues, wins };
}

const who = (it: Item) => it.names.length ? it.names[0] + (it.names.length > 1 ? ` 외 ${it.names.length - 1}` : "") : (it.bid.demand_org || it.bid.org || "");
function lineNew(it: Item, now: number) {
  const b = it.bid, end = endOf(b);
  const t = [end ? `${b.close_at ? "마감" : "개찰"} ${kstTxt(end)} (${dday(end, now)})` : "", won(b.price) ? "추정 " + won(b.price) : ""].filter(Boolean).join(" · ");
  return `· ${cut(who(it), 20)}\n  ${cut(b.title, 40)}${t ? "\n  " + t : ""}`;
}
function lineDue(it: Item, now: number) {
  const b = it.bid, end = endOf(b)!;
  return `· ${cut(who(it), 20)} — ${cut(b.title, 28)}\n  ${b.close_at ? "마감" : "개찰"} ${kstTxt(end)} (${dday(end, now)})`;
}
function lineWin(it: Item) {
  const b = it.bid;
  return `· ${cut(who(it), 20)} — ${cut(b.title, 28)}\n  낙찰 ${cut(b.winner, 24)}${won(b.winner_amt) ? " · " + won(b.winner_amt) : ""}`;
}

// 받는 사람 한 명에게 갈 글. 받을 게 없으면 null
export function buildText(plan: Plan, r: { on_new: boolean; on_due: boolean; on_win: boolean }, appUrl: string, now: number): string | null {
  const secs: { head: string; lines: string[] }[] = [];
  if (r.on_new && plan.news.length) secs.push({ head: `■ 새 입찰 ${plan.news.length}건`, lines: plan.news.map((x) => lineNew(x, now)) });
  if (r.on_due && plan.dues.length) secs.push({ head: `■ 마감 임박 ${plan.dues.length}건`, lines: plan.dues.map((x) => lineDue(x, now)) });
  if (r.on_win && plan.wins.length) secs.push({ head: `■ 낙찰 결과 ${plan.wins.length}건`, lines: plan.wins.map(lineWin) });
  if (!secs.length) return null;
  const head = "[CHM 빌딩정보] 나라장터 입찰 알림";
  const foot = appUrl ? `\n\n앱에서 보기: ${appUrl}` : "";
  const budget = MAX_BYTES - bytesOf(head) - bytesOf(foot) - 40;
  let used = 0; const out: string[] = [];
  for (const s of secs) {
    let body = "\n\n" + s.head; used += bytesOf(body);
    let shown = 0;
    for (const ln of s.lines) {
      const add = "\n" + ln;
      if (used + bytesOf(add) > budget) break;
      body += add; used += bytesOf(add); shown++;
    }
    if (shown < s.lines.length) { const more = `\n  …외 ${s.lines.length - shown}건`; body += more; used += bytesOf(more); }
    out.push(body);
  }
  return head + out.join("") + foot;
}

// ---------------- 솔라피 ----------------
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function solapiAuth(key: string, secret: string) {
  const date = new Date().toISOString();
  const salt = crypto.randomUUID().replace(/-/g, "");
  const k = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", k, enc(date + salt)));
  return `HMAC-SHA256 apiKey=${key}, date=${date}, salt=${salt}, signature=${sig}`;
}
async function solapi(cfg: any, method: string, path: string, body?: unknown) {
  const r = await fetch("https://api.solapi.com/" + path, {
    method, headers: { Authorization: await solapiAuth(cfg.api_key, cfg.api_secret), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000),
  });
  const t = await r.text(); let j: any = {}; try { j = JSON.parse(t); } catch { /* keep */ }
  if (!r.ok) throw new Error(`솔라피 ${j.errorCode ?? r.status}: ${j.errorMessage ?? t.slice(0, 160)}`);
  return j;
}
export function toMessage(to: string, from: string, text: string) {
  return bytesOf(text) <= SMS_BYTES ? { to, from, text, type: "SMS" } : { to, from, text, type: "LMS", subject: "나라장터 입찰 알림" };
}
async function sendMany(cfg: any, msgs: any[]) {
  const j = await solapi(cfg, "POST", "messages/v4/send-many/detail", { messages: msgs, allowDuplicates: true });
  const failed = Array.isArray(j.failedMessageList) ? j.failedMessageList : [];
  return { ok: msgs.length - failed.length, fail: failed.length,
    note: failed.length ? failed.slice(0, 3).map((f: any) => `${f.to ?? ""} ${f.statusCode ?? ""} ${f.statusMessage ?? ""}`.trim()).join(" / ") : null };
}
const digits = (s: any) => String(s ?? "").replace(/\D/g, "");
const mask = (p: string) => p ? p.replace(/^(\d{3})(\d+)(\d{4})$/, (_, a, b, c) => `${a}-${"*".repeat(b.length)}-${c}`) : "";

export async function loadCfg(db: any) {
  const { data } = await db.from("sms_secret").select("api_key, api_secret, sender").eq("id", 1).maybeSingle();
  const c = { api_key: Deno.env.get("SOLAPI_API_KEY") || data?.api_key || "", api_secret: Deno.env.get("SOLAPI_API_SECRET") || data?.api_secret || "",
    sender: digits(Deno.env.get("SOLAPI_SENDER") || data?.sender || "") };
  return { ...c, ready: !!(c.api_key && c.api_secret && c.sender) };
}

// ---------------- 알릴 것 찾아 보내기 ----------------
export async function run(db: any, mode: "auto" | "manual" | "preview") {
  const now = Date.now();
  const [{ data: st }, { data: rc }, { data: links, error: le }, { data: sn }] = await Promise.all([
    db.from("sms_settings").select("*").eq("id", 1).maybeSingle(),
    db.from("sms_recipients").select("id, name, phone, on_new, on_due, on_win").eq("active", true).order("id"),
    db.from("bid_links").select("bid_no, hidden, buildings(name), bids(bid_no, title, org, demand_org, kind, close_at, open_at, price, winner, winner_amt)").eq("hidden", false),
    db.from("bid_notices").select("bid_no, kind"),
  ]);
  if (le) throw new Error("공고 읽기 오류: " + le.message);
  const settings = st ?? { enabled: false, due_days: 3, app_url: "" };
  if (mode !== "preview" && !settings.enabled) return { skipped: "알림이 꺼져 있어요" };
  const sent = new Set<string>((sn ?? []).map((x: any) => x.bid_no + "|" + x.kind));
  const plan = makePlan(links ?? [], sent, settings.due_days || 3, now);
  const counts = { new: plan.news.length, due: plan.dues.length, win: plan.wins.length };
  const recips = rc ?? [];
  const texts = recips.map((r: any) => ({ r, text: buildText(plan, r, settings.app_url, now) })).filter((x: any) => x.text);
  if (mode === "preview") return { counts, recipients: recips.length, enabled: settings.enabled,
    messages: texts.map((x: any) => ({ name: x.r.name, phone: mask(x.r.phone), text: x.text, bytes: bytesOf(x.text!) })) };
  if (!counts.new && !counts.due && !counts.win) return { counts, sent: 0 };
  if (!recips.length) return { counts, sent: 0, skipped: "받는 사람이 없어요" };

  // 받는 사람은 있는데 그 종류를 받는 사람이 없으면 보낼 것 없이 '처리됨'으로 표시
  let ok = 0, fail = 0, note: string | null = null;
  if (texts.length) {
    const cfg = await loadCfg(db);
    if (!cfg.ready) {
      await db.from("sms_log").insert({ mode, n_new: counts.new, n_due: counts.due, n_win: counts.win, recipients: texts.length, note: "솔라피 키가 설정되지 않아 보내지 못했어요" });
      return { counts, sent: 0, error: "솔라피 키가 설정되지 않았어요" };
    }
    try {
      const r = await sendMany(cfg, texts.map((x: any) => toMessage(x.r.phone, cfg.sender, x.text)));
      ok = r.ok; fail = r.fail; note = r.note;
    } catch (e) {
      // 통째로 실패(키·잔액·연결) → 표시하지 않고 다음 번에 다시 시도
      await db.from("sms_log").insert({ mode, n_new: counts.new, n_due: counts.due, n_win: counts.win, recipients: texts.length, fail: texts.length, note: String((e as Error).message).slice(0, 300), body: texts[0].text });
      return { counts, sent: 0, error: (e as Error).message };
    }
    if (!ok) {
      await db.from("sms_log").insert({ mode, n_new: counts.new, n_due: counts.due, n_win: counts.win, recipients: texts.length, fail, note: (note ?? "모두 실패").slice(0, 300), body: texts[0].text });
      return { counts, sent: 0, error: "문자를 한 통도 보내지 못했어요: " + (note ?? "") };
    }
  }
  const rows: any[] = [];
  for (const it of plan.news) {
    rows.push({ bid_no: it.bid.bid_no, kind: "new" });
    const end = endOf(it.bid);   // 새 공고로 알렸는데 이미 마감 임박이면 임박 알림은 따로 안 보냄
    if (end && new Date(end).getTime() - now <= (settings.due_days || 3) * DAY) rows.push({ bid_no: it.bid.bid_no, kind: "due" });
  }
  for (const it of plan.dues) rows.push({ bid_no: it.bid.bid_no, kind: "due" });
  for (const it of plan.wins) rows.push({ bid_no: it.bid.bid_no, kind: "win" });
  if (rows.length) await db.from("bid_notices").upsert(rows, { onConflict: "bid_no,kind", ignoreDuplicates: true });
  await db.from("sms_log").insert({ mode, n_new: counts.new, n_due: counts.due, n_win: counts.win, recipients: texts.length, ok, fail,
    note: texts.length ? note : "이 종류를 받는 사람이 없어 보내지 않고 처리했어요", body: texts[0]?.text ?? null });
  return { counts, sent: ok, fail };
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!;
  let b: any = {};
  try { b = await req.json(); } catch { /* empty */ }
  const db = createClient(url, SERVICE_KEY, { auth: { persistSession: false } });
  let admin = false;
  if (req.headers.get("Authorization")) {
    const caller = createClient(url, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: role } = await caller.rpc("my_role").then((x: any) => x, () => ({ data: null }));
    admin = role === "admin";
  }
  try {
    if (b.action === "run") return json({ ok: true, ...(await run(db, admin ? "manual" : "auto")) });
    if (!admin) return json({ error: "관리자만 쓸 수 있어요." }, 403);
    if (b.action === "preview") return json({ ok: true, ...(await run(db, "preview")) });
    if (b.action === "status") {
      const cfg = await loadCfg(db);
      let balance: number | null = null, err: string | null = null;
      if (cfg.ready) { try { const j = await solapi(cfg, "GET", "cash/v1/balance"); balance = Math.round((+j.balance || 0) + (+j.point || 0)); } catch (e) { err = (e as Error).message; } }
      return json({ ok: true, key: !!cfg.api_key, secret: !!cfg.api_secret, sender: mask(cfg.sender), keyTail: cfg.api_key ? cfg.api_key.slice(-4) : "", balance, err });
    }
    if (b.action === "config") {
      const upd: any = { id: 1, updated_at: new Date().toISOString() };
      const k = String(b.api_key ?? "").trim(), s = String(b.api_secret ?? "").trim(), p = digits(b.sender);
      if (k) upd.api_key = k.slice(0, 100);
      if (s) upd.api_secret = s.slice(0, 200);
      if (b.sender != null && String(b.sender).trim()) { if (!/^0\d{8,10}$/.test(p)) return json({ error: "발신번호 형식이 맞지 않아요 (예: 01012345678, 0212345678)" }, 400); upd.sender = p; }
      const { error } = await db.from("sms_secret").upsert(upd, { onConflict: "id" });
      if (error) throw new Error("저장 오류: " + error.message);
      return json({ ok: true });
    }
    if (b.action === "test") {
      const cfg = await loadCfg(db);
      if (!cfg.ready) return json({ error: "솔라피 API Key·Secret·발신번호를 먼저 넣으세요." }, 400);
      let q = db.from("sms_recipients").select("id, name, phone").eq("active", true);
      if (Array.isArray(b.ids) && b.ids.length) q = q.in("id", b.ids.map((x: any) => +x));
      const { data: rs } = await q;
      if (!rs?.length) return json({ error: "보낼 사람이 없어요." }, 400);
      const text = "[CHM 빌딩정보] 시험 문자예요. 나라장터 입찰 알림이 이 번호로 와요.";
      const r = await sendMany(cfg, rs.map((x: any) => toMessage(x.phone, cfg.sender, text)));
      await db.from("sms_log").insert({ mode: "test", recipients: rs.length, ok: r.ok, fail: r.fail, note: r.note, body: text });
      return json({ ok: true, sent: r.ok, fail: r.fail, note: r.note });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 502);
  }
});
