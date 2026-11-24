// 오프라인 실행용 서비스 워커
// - 앱 파일(같은 출처): 네트워크 우선 → 배포 즉시 새 버전, 오프라인이면 캐시
// - MediaPipe 라이브러리·모델(버전 고정 CDN): 캐시 우선 → 두 번째부터 빠르게, 오프라인에서도 자세 평가
const APP = 'app-v1';
const CDN = 'cdn-v1';
const CORE = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/back-curve.js', 'js/bar-analysis.js', 'js/bar-track.js', 'js/coach.js', 'js/form-3d.js',
  'js/form-analysis.js', 'js/form-eval.js', 'js/garmin-import.js', 'js/garmin.js', 'js/pose.js', 'js/program.js',
  'js/run-analysis.js', 'js/set-window.js', 'js/storage.js', 'js/thresholds.js',
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== APP && k !== CDN).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(APP).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
    );
  } else if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CDN).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
  // 그 외(가민 API 등)는 브라우저 기본 동작
});
