const CACHE = 'frota-conecta-v3';
const ASSETS = [
  '/frota-app/',
  '/frota-app/index.html',
  '/frota-app/manifest.json',
  '/frota-app/icon-192.png',
  '/frota-app/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
});

self.addEventListener('fetch', e => {
  // Requisições ao backend sempre vão para a rede
  if (e.request.url.includes('onrender.com')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
