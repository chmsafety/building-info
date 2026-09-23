-- =============================================================
-- 빌딩정보 시스템 — 나라장터 입찰 문자 알림 (2026-09-23)
-- 등록 빌딩과 연결된 입찰공고가 ① 새로 잡히거나 ② 마감이 임박하거나 ③ 낙찰자가 확인되면
-- '받는 사람' 목록의 휴대폰으로 문자(솔라피)를 보냅니다. 보내는 일은 서버 함수 bid-notify 가 합니다.
-- SQL Editor 에 통째로 붙여넣고 Run. 여러 번 실행해도 안전합니다.
-- =============================================================

-- 1) 받는 사람 (계정이 없어도 됨) — 종류별로 받을지 고를 수 있음
create table if not exists public.sms_recipients (
  id         bigserial primary key,
  name       text not null check (char_length(name) between 1 and 40),
  phone      text not null check (phone ~ '^01[0-9]{8,9}$'),      -- 숫자만 (예: 01012345678)
  on_new     boolean not null default true,    -- 새 입찰공고
  on_due     boolean not null default true,    -- 마감 임박
  on_win     boolean not null default true,    -- 낙찰 결과
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);
create unique index if not exists sms_recipients_phone_idx on public.sms_recipients(phone);

-- 2) 알림 설정 (한 줄)
create table if not exists public.sms_settings (
  id         int primary key default 1 check (id = 1),
  enabled    boolean not null default false,   -- 처음엔 꺼 둠 → 받는 사람·솔라피 키 넣고 켜기
  due_days   int not null default 3 check (due_days between 1 and 14),
  app_url    text not null default 'https://chmsafety.github.io/building-info/',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.sms_settings (id) values (1) on conflict (id) do nothing;

-- 3) 솔라피 키 — 화면에서 넣기만 하고 아무도 다시 읽을 수 없음(서버 함수만 읽음)
create table if not exists public.sms_secret (
  id         int primary key default 1 check (id = 1),
  api_key    text,
  api_secret text,
  sender     text,                                -- 솔라피에 등록된 발신번호 (숫자만)
  updated_at timestamptz not null default now()
);

-- 4) 공고별로 무엇을 이미 알렸는지 (같은 공고·같은 종류는 한 번만)
create table if not exists public.bid_notices (
  bid_no  text not null references public.bids(bid_no) on delete cascade,
  kind    text not null check (kind in ('new','due','win')),
  sent_at timestamptz not null default now(),
  primary key (bid_no, kind)
);

-- 5) 발송 기록
create table if not exists public.sms_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  mode       text,          -- auto(자동) / manual(지금 보내기) / test(시험)
  n_new      int default 0,
  n_due      int default 0,
  n_win      int default 0,
  recipients int default 0,
  ok         int default 0,
  fail       int default 0,
  note       text,
  body       text
);
create index if not exists sms_log_at_idx on public.sms_log(at desc);

-- 6) 보안: 전부 관리자만. 솔라피 키 표는 누구도 못 읽음. 발송·기록은 서버 함수(서비스 키)만.
alter table public.sms_recipients enable row level security;
alter table public.sms_settings   enable row level security;
alter table public.sms_secret     enable row level security;
alter table public.bid_notices    enable row level security;
alter table public.sms_log        enable row level security;
revoke all on public.sms_recipients, public.sms_settings, public.sms_secret, public.bid_notices, public.sms_log from anon;
revoke all on public.sms_secret from authenticated;
revoke all on public.bid_notices, public.sms_log from authenticated;
grant select, insert, update, delete on public.sms_recipients to authenticated;
grant usage, select on sequence public.sms_recipients_id_seq to authenticated;
grant select, update on public.sms_settings to authenticated;
grant select on public.bid_notices, public.sms_log to authenticated;

drop policy if exists p_smsr_all on public.sms_recipients;
create policy p_smsr_all on public.sms_recipients for all to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');
drop policy if exists p_smss_select on public.sms_settings;
create policy p_smss_select on public.sms_settings for select to authenticated using (public.my_role() = 'admin');
drop policy if exists p_smss_update on public.sms_settings;
create policy p_smss_update on public.sms_settings for update to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');
drop policy if exists p_bidn_select on public.bid_notices;
create policy p_bidn_select on public.bid_notices for select to authenticated using (public.my_role() = 'admin');
drop policy if exists p_smsl_select on public.sms_log;
create policy p_smsl_select on public.sms_log for select to authenticated using (public.my_role() = 'admin');

-- 누가 언제 바꿨는지 자동 기록
create or replace function public.sms_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'sms_recipients' then
    if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
    new.phone := regexp_replace(coalesce(new.phone, ''), '[^0-9]', '', 'g');
  else
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  return new;
end $$;
drop trigger if exists t_smsr_stamp on public.sms_recipients;
create trigger t_smsr_stamp before insert or update on public.sms_recipients for each row execute function public.sms_stamp();
drop trigger if exists t_smss_stamp on public.sms_settings;
create trigger t_smss_stamp before update on public.sms_settings for each row execute function public.sms_stamp();

-- 7) 지금 있는 공고는 '이미 알린 것'으로 표시 — 켜자마자 지난 공고가 한꺼번에 날아가지 않게
insert into public.bid_notices (bid_no, kind) select bid_no, 'new' from public.bids on conflict do nothing;
insert into public.bid_notices (bid_no, kind) select bid_no, 'win' from public.bids where winner is not null on conflict do nothing;
insert into public.bid_notices (bid_no, kind) select bid_no, 'due' from public.bids
  where coalesce(close_at, open_at) is null or coalesce(close_at, open_at) < now() + interval '3 days' on conflict do nothing;

-- 8) 자동 발송: 매일 오전 7시 15분·오후 6시 15분(한국시간) — 입찰 자동 확인(7시·18시) 15분 뒤
do $$ begin
  perform cron.unschedule('bid-notify') where exists (select 1 from cron.job where jobname = 'bid-notify');
  perform cron.schedule('bid-notify', '15 22,9 * * *', $cron$
    select net.http_post(
      url := 'https://dbymktwxokbvfshlztrg.supabase.co/functions/v1/bid-notify',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{"action":"run"}'::jsonb,
      timeout_milliseconds := 60000);
  $cron$);
exception when others then raise notice '예약 발송을 만들지 못했어요 (pg_cron·pg_net 확인): %', sqlerrm;
end $$;

-- 9) (2026-09-23 추가) 계정과 연결 — 계정 관리 표에서 계정별로 번호·수신을 설정
alter table public.sms_recipients add column if not exists profile_id uuid references public.profiles(id) on delete cascade;
create unique index if not exists sms_recipients_profile_idx on public.sms_recipients(profile_id);
