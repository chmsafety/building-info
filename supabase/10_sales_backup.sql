-- =============================================================
-- 빌딩정보 시스템 — 영업 파이프라인 · 낙찰 연동 · 자동 백업 (2026-09-21)
-- SQL Editor 에 통째로 붙여넣고 Run. 여러 번 실행해도 안전합니다.
-- (pg_cron 은 08_bids.sql 때 이미 켜 두었어요)
-- =============================================================

-- 1) 나라장터: 빌딩별 발주기관명 (공고의 수요기관·공고기관과 비교)
alter table public.buildings add column if not exists bid_orgs text;
grant update (bid_orgs) on public.buildings to authenticated;

-- 2) 영업 현황 (빌딩당 한 줄)
create table if not exists public.sales (
  building_id  text primary key references public.buildings(id) on delete cascade,
  stage        text not null default 'target'
               check (stage in ('target','contact','proposal','bid','won','lost','hold')),
  owner_id     uuid references public.profiles(id) on delete set null,   -- 영업 담당자
  next_action  text check (char_length(next_action) <= 200),             -- 다음 할 일
  next_date    date,                                                     -- 다음 할 일 날짜
  contract_end date,                                                     -- 확인된 현 관리사 계약 만료일
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.profiles(id) on delete set null
);
create index if not exists sales_next_idx on public.sales(next_date);

-- 3) 영업 활동 기록
create table if not exists public.sales_activities (
  id          bigserial primary key,
  building_id text not null references public.buildings(id) on delete cascade,
  day         date not null default ((now() at time zone 'Asia/Seoul')::date),
  kind        text not null check (kind in ('방문','전화','메일','미팅','제안','입찰','기타')),
  note        text not null check (char_length(note) between 1 and 2000),
  user_id     uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists sales_act_bld_idx on public.sales_activities(building_id, day desc);

-- 수정한 사람·시각은 서버가 기록
create or replace function public.sales_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists trg_sales_stamp on public.sales;
create trigger trg_sales_stamp before insert or update on public.sales
  for each row execute function public.sales_stamp();

create or replace function public.sales_act_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid();
  new.created_at := now();
  return new;
end $$;
drop trigger if exists trg_sales_act_stamp on public.sales_activities;
create trigger trg_sales_act_stamp before insert on public.sales_activities
  for each row execute function public.sales_act_stamp();

-- 보안: 활성 사용자 읽기, 편집자·관리자만 쓰기. 활동 기록은 본인 것(관리자는 전부)만 지울 수 있음.
alter table public.sales            enable row level security;
alter table public.sales_activities enable row level security;
revoke all on public.sales, public.sales_activities from anon;
grant select, insert, update, delete on public.sales to authenticated;
grant select, insert, delete on public.sales_activities to authenticated;
grant usage on sequence public.sales_activities_id_seq to authenticated;

drop policy if exists p_sales_select on public.sales;
create policy p_sales_select on public.sales for select to authenticated using (public.is_active_user());
drop policy if exists p_sales_insert on public.sales;
create policy p_sales_insert on public.sales for insert to authenticated with check (public.can_edit());
drop policy if exists p_sales_update on public.sales;
create policy p_sales_update on public.sales for update to authenticated using (public.can_edit()) with check (public.can_edit());
drop policy if exists p_sales_delete on public.sales;
create policy p_sales_delete on public.sales for delete to authenticated using (public.can_edit());

drop policy if exists p_sact_select on public.sales_activities;
create policy p_sact_select on public.sales_activities for select to authenticated using (public.is_active_user());
drop policy if exists p_sact_insert on public.sales_activities;
create policy p_sact_insert on public.sales_activities for insert to authenticated with check (public.can_edit());
drop policy if exists p_sact_delete on public.sales_activities;
create policy p_sact_delete on public.sales_activities for delete to authenticated
  using (public.can_edit() and (user_id = auth.uid() or public.my_role() = 'admin'));

-- 4) 자동 백업: 주요 표를 통째로 JSON 으로 저장 (최근 12개 보관)
create table if not exists public.backups (
  id    bigserial primary key,
  at    timestamptz not null default now(),
  kind  text not null default 'auto',     -- auto(매주) / manual(관리자)
  rows  int,
  size  int,
  data  jsonb not null
);
alter table public.backups enable row level security;
revoke all on public.backups from anon, authenticated;
grant select on public.backups to authenticated;
drop policy if exists p_backups_select on public.backups;
create policy p_backups_select on public.backups for select to authenticated using (public.my_role() = 'admin');

create or replace function public.make_backup(p_kind text default 'manual') returns bigint
language plpgsql security definer set search_path = public as $$
declare d jsonb; n int; bid bigint;
begin
  -- 로그인한 사람은 관리자만. (예약 작업은 로그인 없이 서버 안에서 실행)
  if auth.uid() is not null and coalesce(public.my_role(), '') <> 'admin' then raise exception 'forbidden'; end if;
  d := jsonb_build_object(
    'version', 1,
    'at', now(),
    'buildings',        coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.buildings t), '[]'::jsonb),
    'sales',            coalesce((select jsonb_agg(to_jsonb(t)) from public.sales t), '[]'::jsonb),
    'sales_activities', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.sales_activities t), '[]'::jsonb),
    'fm_suggestions',   coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.fm_suggestions t), '[]'::jsonb),
    'bids',             coalesce((select jsonb_agg(to_jsonb(t)) from public.bids t), '[]'::jsonb),
    'bid_links',        coalesce((select jsonb_agg(to_jsonb(t)) from public.bid_links t), '[]'::jsonb),
    'profiles',         coalesce((select jsonb_agg(jsonb_build_object('id', id, 'login_id', login_id, 'name', name, 'role', role, 'active', active)) from public.profiles), '[]'::jsonb)
  );
  n := jsonb_array_length(d->'buildings') + jsonb_array_length(d->'sales') + jsonb_array_length(d->'sales_activities')
     + jsonb_array_length(d->'fm_suggestions') + jsonb_array_length(d->'bids') + jsonb_array_length(d->'bid_links');
  insert into public.backups(kind, rows, size, data)
    values (case when p_kind = 'auto' then 'auto' else 'manual' end, n, octet_length(d::text), d)
    returning id into bid;
  delete from public.backups where id not in (select id from public.backups order by at desc limit 12);
  return bid;
end $$;
revoke all on function public.make_backup(text) from public, anon;
grant execute on function public.make_backup(text) to authenticated;

-- 매주 월요일 새벽 3시(한국시간) 자동 백업
do $$ begin
  perform cron.unschedule('weekly-backup') where exists (select 1 from cron.job where jobname = 'weekly-backup');
  perform cron.schedule('weekly-backup', '0 18 * * 0', 'select public.make_backup(''auto'')');
exception when others then raise notice '예약 백업을 만들지 못했어요 (pg_cron 확인): %', sqlerrm;
end $$;

-- 첫 백업을 바로 한 번
select public.make_backup('auto');

-- =============================================================
-- [되살리기 예시] 백업 id 가 5 이고, 빌딩 한 곳(id='s001')을 그때 상태로 되돌릴 때:
--   update public.buildings b set (name, address, fm, staff, memo) =
--     (select r.name, r.address, r.fm, r.staff, r.memo
--        from jsonb_populate_record(null::public.buildings,
--             (select e from public.backups k, jsonb_array_elements(k.data->'buildings') e
--               where k.id = 5 and e->>'id' = 's001')) r)
--    where b.id = 's001';
-- 전체를 되돌려야 하면 Claude 에게 백업 id 를 알려 주고 요청하세요.
-- =============================================================
