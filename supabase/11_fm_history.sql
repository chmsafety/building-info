-- =============================================================
-- 빌딩정보 시스템 — 관리업체 변경 이력 (2026-09-21)
-- 관리업체(시설·보안·미화·기타·PM)를 바꾸거나 새로 넣으면
-- '어느 회사가 언제부터 언제까지 맡았는지' 가 자동으로 쌓입니다.
-- 함께 남기는 것: 계약기간 글, 출처, 기록 경위.
-- SQL Editor 에 통째로 붙여넣고 Run. 여러 번 실행해도 안전합니다.
-- (10_sales_backup.sql 다음에 실행)
-- =============================================================

-- 1) 이력 표 -------------------------------------------------
create table if not exists public.fm_history (
  id          bigserial primary key,
  building_id text not null references public.buildings(id) on delete cascade,
  role        text not null check (role in ('facility','security','cleaning','other','pm')),
  company     text not null check (char_length(company) between 1 and 120),
  started_on  date,                      -- 맡기 시작한 날 (모르면 비워 둠)
  ended_on    date,                      -- 끝난 날. 비어 있으면 '현재 업체'
  period      text check (char_length(period) <= 120),   -- 그때의 계약기간 글
  source      text check (char_length(source) <= 500),   -- 출처(링크 등)
  note        text check (char_length(note)   <= 300),   -- 기록 경위 / 메모
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id) on delete set null,
  ended_by    uuid references public.profiles(id) on delete set null
);
create index if not exists fm_hist_bld_idx on public.fm_history(building_id, role, started_on desc);
-- 한 빌딩·한 역할에 '현재 업체'는 하나만
create unique index if not exists fm_hist_open_idx on public.fm_history(building_id, role) where ended_on is null;

-- 2) 도우미 함수 ---------------------------------------------
-- 회사명 비교용 열쇠: 띄어쓰기·(주)·㈜·주식회사 를 빼고 소문자로
create or replace function public.fm_key(c text) returns text
language sql immutable as $$
  select lower(regexp_replace(coalesce(c,''), '\s|\(주\)|㈜|주식회사', '', 'g'))
$$;

-- 빌딩 한 줄에서 역할별 값 꺼내기 (what: company / period / source)
create or replace function public.fm_pick(fm jsonb, staff jsonb, r text, what text) returns text
language sql immutable as $$
  select nullif(btrim(case
    when r = 'facility' then case what when 'company' then fm->>'company' when 'period' then fm->>'period' else fm->>'source' end
    when r = 'pm'       then case what when 'company' then fm->>'pm'      when 'period' then null          else fm->>'pm_source' end
    else                     case what when 'company' then staff->r->>'company' when 'period' then staff->r->>'period' else staff->r->>'source' end
  end), '')
$$;

-- "2025.01 ~ 2027.12" 같은 글에서 시작일 찾기
create or replace function public.fm_period_start(p text) returns date
language plpgsql immutable as $$
declare m text[]; y int; mo int; d int;
begin
  if p is null then return null; end if;
  m := regexp_match(p, '(20\d{2})\s*[.\-/년]\s*(\d{1,2})?\s*[.\-/월]?\s*(\d{1,2})?');
  if m is null then return null; end if;
  y := m[1]::int; mo := coalesce(m[2]::int, 1); d := coalesce(m[3]::int, 1);
  if mo < 1 or mo > 12 then mo := 1; end if;
  if d  < 1 or d  > 31 then d  := 1; end if;
  return make_date(y, mo, d);
exception when others then return null;
end $$;

-- 3) 자동 기록 트리거 ----------------------------------------
create or replace function public.fm_history_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  roles  text[] := array['facility','security','cleaning','other','pm'];
  r      text;
  oldc   text; newc text; oldper text; newper text; newsrc text;
  today  date := (now() at time zone 'Asia/Seoul')::date;
  st     date;
begin
  foreach r in array roles loop
    newc   := fm_pick(NEW.fm, NEW.staff, r, 'company');
    newper := fm_pick(NEW.fm, NEW.staff, r, 'period');
    newsrc := fm_pick(NEW.fm, NEW.staff, r, 'source');
    if TG_OP = 'UPDATE' then
      oldc   := fm_pick(OLD.fm, OLD.staff, r, 'company');
      oldper := fm_pick(OLD.fm, OLD.staff, r, 'period');
    else
      oldc := null; oldper := null;
    end if;

    -- (가) 같은 회사: 이름 표기·계약기간·출처만 최신으로
    if fm_key(oldc) = fm_key(newc) then
      if newc is not null then
        update fm_history
           set company = newc, period = newper, source = newsrc
         where building_id = NEW.id and role = r and ended_on is null
           and (company is distinct from newc or period is distinct from newper or source is distinct from newsrc);
      end if;
      continue;
    end if;

    -- (나) 회사가 바뀜 → 시작일 정하기
    --     계약기간 글도 같이 바뀌었으면 그 시작일, 아니면 오늘
    if newper is not null and newper is distinct from oldper then
      st := coalesce(fm_period_start(newper), today);
    else
      st := today;
    end if;
    if st > today then st := today; end if;

    -- 오늘 기록된 '현재 업체'를 같은 날 다시 고친 경우 = 오타 정정으로 보고 그 줄을 고쳐 씀
    --  (하루짜리 빈 이력이 생기지 않게. 처음 채워 넣은 '기존 자료' 줄은 정상적으로 닫음)
    if newc is not null and exists (
         select 1 from fm_history
          where building_id = NEW.id and role = r and ended_on is null
            and started_on = today and note in ('등록','변경')
            and (created_at at time zone 'Asia/Seoul')::date = today) then
      update fm_history
         set company = left(newc,120), period = left(newper,120), source = left(newsrc,500)
       where building_id = NEW.id and role = r and ended_on is null;
      continue;
    end if;

    -- 기존 '현재 업체' 닫기
    update fm_history
       set ended_on = greatest(coalesce(started_on, st), st - 1), ended_by = auth.uid()
     where building_id = NEW.id and role = r and ended_on is null;

    -- 새 업체 기록 (비우기만 한 경우엔 닫기만)
    if newc is not null then
      insert into fm_history(building_id, role, company, started_on, period, source, note, created_by)
        values (NEW.id, r, left(newc,120), st, left(newper,120), left(newsrc,500), case when TG_OP='INSERT' then '등록' else '변경' end, auth.uid());
    end if;
  end loop;
  return null;
end $$;

drop trigger if exists trg_fm_history on public.buildings;
create trigger trg_fm_history after insert or update of fm, staff on public.buildings
  for each row execute function public.fm_history_sync();

-- 4) 손으로 넣은 이력의 작성자·시각은 서버가 기록 ------------
create or replace function public.fm_hist_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    new.created_at := now();
    new.created_by := coalesce(auth.uid(), new.created_by);
  end if;
  if new.ended_on is not null and (TG_OP = 'INSERT' or old.ended_on is null) then
    new.ended_by := coalesce(auth.uid(), new.ended_by);
  end if;
  return new;
end $$;
drop trigger if exists trg_fm_hist_stamp on public.fm_history;
create trigger trg_fm_hist_stamp before insert or update on public.fm_history
  for each row execute function public.fm_hist_stamp();

-- 5) 보안: 활성 사용자 보기, 편집자·관리자 넣고 고치기, 삭제는 관리자 --
alter table public.fm_history enable row level security;
revoke all on public.fm_history from anon;
grant select, insert, update, delete on public.fm_history to authenticated;
grant usage on sequence public.fm_history_id_seq to authenticated;

drop policy if exists p_fmh_select on public.fm_history;
create policy p_fmh_select on public.fm_history for select to authenticated using (public.is_active_user());
drop policy if exists p_fmh_insert on public.fm_history;
create policy p_fmh_insert on public.fm_history for insert to authenticated with check (public.can_edit());
drop policy if exists p_fmh_update on public.fm_history;
create policy p_fmh_update on public.fm_history for update to authenticated using (public.can_edit()) with check (public.can_edit());
drop policy if exists p_fmh_delete on public.fm_history;
create policy p_fmh_delete on public.fm_history for delete to authenticated using (public.my_role() = 'admin');

-- 6) 지금 입력돼 있는 관리업체를 '현재 업체'로 한 번 채우기 ----
insert into public.fm_history(building_id, role, company, started_on, period, source, note)
select b.id, x.r,
       public.fm_pick(b.fm, b.staff, x.r, 'company'),
       public.fm_period_start(public.fm_pick(b.fm, b.staff, x.r, 'period')),
       public.fm_pick(b.fm, b.staff, x.r, 'period'),
       public.fm_pick(b.fm, b.staff, x.r, 'source'),
       '기존 자료'
  from public.buildings b
  cross join unnest(array['facility','security','cleaning','other','pm']) as x(r)
 where public.fm_pick(b.fm, b.staff, x.r, 'company') is not null
   and not exists (select 1 from public.fm_history h
                    where h.building_id = b.id and h.role = x.r and h.ended_on is null);

-- 7) 백업에도 이력을 포함 (10_sales_backup.sql 의 함수를 갱신) ----
create or replace function public.make_backup(p_kind text default 'manual') returns bigint
language plpgsql security definer set search_path = public as $$
declare d jsonb; n int; bid bigint;
begin
  if auth.uid() is not null and coalesce(public.my_role(), '') <> 'admin' then raise exception 'forbidden'; end if;
  d := jsonb_build_object(
    'version', 2,
    'at', now(),
    'buildings',        coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.buildings t), '[]'::jsonb),
    'fm_history',       coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.fm_history t), '[]'::jsonb),
    'sales',            coalesce((select jsonb_agg(to_jsonb(t)) from public.sales t), '[]'::jsonb),
    'sales_activities', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.sales_activities t), '[]'::jsonb),
    'fm_suggestions',   coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.fm_suggestions t), '[]'::jsonb),
    'bids',             coalesce((select jsonb_agg(to_jsonb(t)) from public.bids t), '[]'::jsonb),
    'bid_links',        coalesce((select jsonb_agg(to_jsonb(t)) from public.bid_links t), '[]'::jsonb),
    'profiles',         coalesce((select jsonb_agg(jsonb_build_object('id', id, 'login_id', login_id, 'name', name, 'role', role, 'active', active)) from public.profiles), '[]'::jsonb)
  );
  n := jsonb_array_length(d->'buildings') + jsonb_array_length(d->'fm_history') + jsonb_array_length(d->'sales') + jsonb_array_length(d->'sales_activities')
     + jsonb_array_length(d->'fm_suggestions') + jsonb_array_length(d->'bids') + jsonb_array_length(d->'bid_links');
  insert into public.backups(kind, rows, size, data)
    values (case when p_kind = 'auto' then 'auto' else 'manual' end, n, octet_length(d::text), d)
    returning id into bid;
  delete from public.backups where id not in (select id from public.backups order by at desc limit 12);
  return bid;
end $$;
revoke all on function public.make_backup(text) from public, anon;
grant execute on function public.make_backup(text) to authenticated;

-- 확인용: 이력이 몇 건 쌓였는지
select count(*) as 이력건수 from public.fm_history;
