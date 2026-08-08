/* sw.js — Service Worker de Olimpistas (PWA).
 *
 * Estrategia NETWORK-FIRST: siempre intenta la red (así cada deploy se ve al
 * instante) y usa la caché solo como respaldo offline. La API nunca se cachea.
 * (Se evita el cache-first para que el usuario no quede "pegado" a versiones viejas.)
 */
const VERSION = "oli-v7";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Canónico: si la navegación cayó en el dominio PELADO (típico shell cacheado), el propio
  // SW redirige a www ANTES de servir nada. Evita el "Failed to fetch" por origen equivocado.
  if (request.mode === "navigate" && url.hostname === "olimpistas.com") {
    e.respondWith(Response.redirect("https://www.olimpistas.com" + url.pathname + url.search, 302));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api")) return; // API: siempre a la red

  // Network-first: red → (si hay) cachea copia → fallback a caché si no hay red.
  e.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then((r) => r || caches.match("/")))
  );
});
