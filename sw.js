// Building 앱 설치용 서비스 워커.
// 같은 주소의 화면 파일만 '네트워크 먼저'로 받고, 끊겼을 때만 마지막 사본을 보여 줍니다.
// 데이터(Supabase)·지도 등 다른 주소 요청은 건드리지 않습니다.
const CACHE = 'building-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(fetch(r).then(res => {
    if (res.ok) { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)); }
    return res;
  }).catch(() => caches.match(r).then(m => m || caches.match('./'))));
});
