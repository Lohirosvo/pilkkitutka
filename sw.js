// Pilkkitutka – service worker v022
// Verkko ensin, välimuisti varalla: jäällä ilman kenttää näkyy viimeksi haettu sivu ja data.
const VERSIO = 'pilkkitutka-v022';
const KUORI = ['./', './index.html', './kartta.js', './tilanne.js', './luotaus.js', './retki.js', './vaarat.js', './jarvisyvyys.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSIO).then(c => c.addAll(KUORI)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(avaimet =>
    Promise.all(avaimet.filter(k => k !== VERSIO).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) {
        const kopio = r.clone();
        // datan avain ilman ?t=-kyselyä, ettei välimuisti kasva joka haulla
        const avain = url.pathname.endsWith('.json') ? url.origin + url.pathname : e.request;
        caches.open(VERSIO).then(c => c.put(avain, kopio));
      }
      return r;
    }).catch(() =>
      caches.match(e.request, { ignoreSearch: true }).then(m => m || (
        url.pathname.endsWith('.json') ? new Response('', { status: 504 }) : caches.match('./index.html'))))
  );
});
