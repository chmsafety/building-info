-- =====================================================================
-- 14_contacts_files_audit.sql  (2026-09-27)
--  ④ 빌딩별 연락처 여러 명      → contacts 표
--  ⑥ 영업 활동 기록 첨부파일    → sales_activities.files + 저장소 sales-files
--  ⑧ 전국 검색                  → search_buildings(q) 함수
--  ⑲ 접속·변경 기록 (관리자)    → logs 에 영업·활동·연락처 변경도 남김, 로그인 기록은 관리자만 조회
-- 여러 번 실행해도 안전합니다.
-- =====================================================================

-- ---------- ④ 연락처 ----------
create table if not exists public.contacts(
  id          bigint generated always as identity primary key,
  building_id text not null references public.buildings(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  org         text check (org is null or char_length(org) <= 60),      -- 소속: 관리사무소·발주처·소유주 측 등
  title       text check (title is null or char_length(title) <= 60),  -- 직책
  phone       text check (phone is null or char_length(phone) <= 40),
  email       text check (email is null or char_length(email) <= 120),
  memo        text check (memo is null or char_length(memo) <= 500),
  is_primary  boolean not null default false,
  created_by  uuid, created_at timestamptz not null default now(),
  updated_by  uuid, updated_at timestamptz not null default now()
);
create index if not exists contacts_building_idx on public.contacts(building_id);
alter table public.contacts enable row level security;
drop policy if exists p_contacts_select on public.contacts;
drop policy if exists p_contacts_insert on public.contacts;
drop policy if exists p_contacts_update on public.contacts;
drop policy if exists p_contacts_delete on public.contacts;
create policy p_contacts_select on public.contacts for select using (public.is_active_user());
create policy p_contacts_insert on public.contacts for insert with check (public.can_edit());
create policy p_contacts_update on public.contacts for update using (public.can_edit()) with check (public.can_edit());
create policy p_contacts_delete on public.contacts for delete using (public.can_edit());

create or replace function public.contacts_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then new.created_by := auth.uid(); new.created_at := now();
  else new.created_by := old.created_by; new.created_at := old.created_at; end if;
  new.updated_by := auth.uid(); new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_contacts_stamp on public.contacts;
create trigger trg_contacts_stamp before insert or update on public.contacts
  for each row execute function public.contacts_stamp();

-- ---------- ⑥ 활동 기록 첨부파일 ----------
alter table public.sales_activities add column if not exists files jsonb not null default '[]'::jsonb;

insert into storage.buckets(id, name, public, file_size_limit)
values ('sales-files', 'sales-files', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = 20971520;

drop policy if exists p_sfiles_read   on storage.objects;
drop policy if exists p_sfiles_write  on storage.objects;
drop policy if exists p_sfiles_delete on storage.objects;
create policy p_sfiles_read   on storage.objects for select using (bucket_id = 'sales-files' and public.is_active_user());
create policy p_sfiles_write  on storage.objects for insert with check (bucket_id = 'sales-files' and public.can_edit());
create policy p_sfiles_delete on storage.objects for delete using (bucket_id = 'sales-files' and public.can_edit());

-- ---------- ⑧ 전국 검색 (RLS 그대로 적용: security invoker) ----------
create or replace function public.search_buildings(q text)
returns table(id text, name text, address text, region text, district text, gfa numeric, company text)
language sql stable security invoker set search_path = public as $$
  with k as (select '%' || replace(replace(replace(trim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%' as p,
                    trim(q) as t)
  select b.id, b.name, b.address, b.region, b.district, b.gfa,
         coalesce(b.fm->>'company', b.staff->'security'->>'company', b.staff->'cleaning'->>'company')
  from public.buildings b, k
  where char_length(k.t) >= 2
    and (b.name ilike k.p or b.address ilike k.p or b.district ilike k.p
         or b.fm->>'company' ilike k.p or b.fm->>'pm' ilike k.p
         or b.staff->'security'->>'company' ilike k.p or b.staff->'cleaning'->>'company' ilike k.p
         or b.staff->'other'->>'company' ilike k.p)
  order by (b.name ilike k.t || '%') desc, b.gfa desc nulls last
  limit 60
$$;
grant execute on function public.search_buildings(text) to authenticated;

-- ---------- ⑲ 변경 기록 확대 ----------
create index if not exists logs_at_idx on public.logs(at desc);
create index if not exists logs_user_idx on public.logs(user_id, at desc);

-- 영업·활동기록·연락처 변경도 logs 에 남김
create or replace function public.log_child() returns trigger
language plpgsql security definer set search_path = public as $$
declare bid text; bn text; f text[] := '{}';
begin
  if tg_op = 'DELETE' then bid := old.building_id; else bid := new.building_id; end if;
  select name into bn from public.buildings where id = bid;
  if bn is null and tg_op = 'DELETE' then return null; end if;   -- 빌딩을 지울 때 함께 지워지는 건 따로 남기지 않음
  if tg_table_name = 'sales_activities' then
    if tg_op = 'DELETE' then f := array[coalesce(old.kind, '')]; else f := array[coalesce(new.kind, '')]; end if;
  elsif tg_table_name = 'contacts' then
    if tg_op = 'DELETE' then f := array[coalesce(old.name, '')]; else f := array[coalesce(new.name, '')]; end if;
  end if;
  insert into public.logs(user_id, action, building_id, building_name, fields)
  values (auth.uid(),
          tg_argv[0] || case tg_op when 'INSERT' then ' 추가' when 'UPDATE' then ' 수정' else ' 삭제' end,
          bid, bn, f);
  return null;
end $$;
drop trigger if exists trg_log_sales on public.sales;
create trigger trg_log_sales after insert or update or delete on public.sales
  for each row execute function public.log_child('영업');
drop trigger if exists trg_log_sact on public.sales_activities;
create trigger trg_log_sact after insert or delete on public.sales_activities
  for each row execute function public.log_child('활동 기록');
drop trigger if exists trg_log_contacts on public.contacts;
create trigger trg_log_contacts after insert or update or delete on public.contacts
  for each row execute function public.log_child('연락처');

-- 로그인 기록은 관리자만 볼 수 있게 (빌딩 변경 이력은 지금처럼 모두)
drop policy if exists p_logs_select on public.logs;
create policy p_logs_select on public.logs for select
  using (public.is_active_user() and (building_id is not null or public.my_role() = 'admin'));

-- 백업에 연락처 포함
create or replace function public.make_backup(p_kind text default 'manual')
returns bigint language plpgsql security definer set search_path = public as $$
declare d jsonb; n int; bid bigint;
begin
  if auth.uid() is not null and coalesce(public.my_role(), '') <> 'admin' then raise exception 'forbidden'; end if;
  d := jsonb_build_object(
    'version', 3,
    'at', now(),
    'buildings',        coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.buildings t), '[]'::jsonb),
    'fm_history',       coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.fm_history t), '[]'::jsonb),
    'sales',            coalesce((select jsonb_agg(to_jsonb(t)) from public.sales t), '[]'::jsonb),
    'sales_activities', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.sales_activities t), '[]'::jsonb),
    'contacts',         coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.contacts t), '[]'::jsonb),
    'fm_suggestions',   coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.fm_suggestions t), '[]'::jsonb),
    'bids',             coalesce((select jsonb_agg(to_jsonb(t)) from public.bids t), '[]'::jsonb),
    'bid_links',        coalesce((select jsonb_agg(to_jsonb(t)) from public.bid_links t), '[]'::jsonb),
    'profiles',         coalesce((select jsonb_agg(jsonb_build_object('id', id, 'login_id', login_id, 'name', name, 'role', role, 'active', active)) from public.profiles), '[]'::jsonb)
  );
  n := jsonb_array_length(d->'buildings') + jsonb_array_length(d->'fm_history') + jsonb_array_length(d->'sales') + jsonb_array_length(d->'sales_activities')
     + jsonb_array_length(d->'contacts') + jsonb_array_length(d->'fm_suggestions') + jsonb_array_length(d->'bids') + jsonb_array_length(d->'bid_links');
  insert into public.backups(kind, rows, size, data)
    values (case when p_kind = 'auto' then 'auto' else 'manual' end, n, octet_length(d::text), d)
    returning id into bid;
  delete from public.backups where id not in (select id from public.backups order by at desc limit 12);
  return bid;
end $$;
