-- =============================================================
-- 빌딩정보 시스템 — 시도 목록·건수 (2026-09-22)
-- SQL Editor 에 붙여넣고 Run. 여러 번 실행해도 안전합니다.
--
-- 전국으로 넓히면 앱이 "시도를 먼저 고르고 그 시도의 빌딩만" 받습니다.
-- 그러려면 어느 시도에 빌딩이 몇 곳 있는지를 먼저 가볍게 알아야 해서 만든 함수예요.
-- (빌딩 자료를 통째로 받지 않고 시도별 개수만 받습니다)
--
-- 이 함수를 만들지 않아도 앱은 동작합니다 — 다만 예전처럼 전체를 한 번에 불러와요.
-- =============================================================
create or replace function public.region_counts()
returns table(region text, n bigint)
language sql security definer stable set search_path = public as $$
  select b.region::text, count(*)::bigint
    from public.buildings b
   where public.is_active_user()
     and b.region is not null and b.region <> ''
   group by b.region
   order by count(*) desc, b.region
$$;
revoke all on function public.region_counts() from public, anon;
grant execute on function public.region_counts() to authenticated;
