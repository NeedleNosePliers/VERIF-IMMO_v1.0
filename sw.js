/* VERIF-IMMO — fonctionnement hors ligne. Changer VERSION à chaque mise à jour de l'appli. */
const VERSION = '3.2';
const CACHE = 'verif-immo-' + VERSION;
const FILES = [
  './', 'index.html', `style.css?v=${VERSION}`, `engine.js?v=${VERSION}`, `app.js?v=${VERSION}`,
  'manifest.webmanifest', `favicon.svg?v=${VERSION}`, `favicon-32.png?v=${VERSION}`, `apple-touch-icon.png?v=${VERSION}`, 'icon-192.png', 'icon-512.png',
  'vendor/xlsx.full.min.js', 'vendor/jspdf.umd.min.js', 'vendor/jspdf.plugin.autotable.min.js',
  'vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js',
  'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract/core/tesseract-core-lstm.wasm.js',
  'vendor/tesseract/lang/fra.traineddata.gz'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('verif-immo-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // la page : réseau d'abord (pour récupérer les mises à jour), sinon la copie enregistrée
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put('index.html', cp)); return r; })
      .catch(() => caches.match('index.html')));
    return;
  }
  // le reste : copie enregistrée d'abord, sinon réseau
  e.respondWith(caches.match(req, { ignoreSearch: false }).then(r => r || fetch(req).then(res => {
    if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
    return res;
  })));
});
