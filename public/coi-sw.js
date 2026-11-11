// Gives a statically hosted page (e.g. GitHub Pages, which can't set headers) the
// COOP/COEP headers it needs for crossOriginIsolated, so WASM can use threads.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
  e.respondWith(
    fetch(r)
      .then((res) => {
        if (res.status === 0) return res; // opaque: leave untouched
        const h = new Headers(res.headers);
        h.set('Cross-Origin-Embedder-Policy', 'require-corp');
        h.set('Cross-Origin-Opener-Policy', 'same-origin');
        h.set('Cross-Origin-Resource-Policy', 'cross-origin');
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
      })
      .catch((err) => Promise.reject(err)),
  );
});
