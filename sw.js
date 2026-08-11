const CACHE = 'frota-conecta-v9';
const ASSETS = [
  '/frota-app/',
  '/frota-app/index.html',
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
    caches.keys().then(keys => 
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('onrender.com')) return;
  // Sempre busca da rede primeiro (ignorando cache HTTP), usa cache só se falhar
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request))
  );
});
