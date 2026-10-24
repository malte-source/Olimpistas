/* sw.js — Service Worker de Olimpistas (PWA).
 *
 * Estrategia NETWORK-FIRST: siempre intenta la red (así cada deploy se ve al
 * instante) y usa la caché solo como respaldo offline. La API nunca se cachea.
 * (Se evita el cache-first para que el usuario no quede "pegado" a versiones viejas.)
 */
const VERSION = "oli-v17";

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

// ── Notificaciones push: el servidor manda {titulo, cuerpo, url, tag}; al tocar el aviso se abre esa página de Olimpistas ──
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { titulo: "Olimpistas", cuerpo: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.titulo || "Olimpistas", {
    body: d.cuerpo || "", icon: "/assets/icon-192.png", badge: "/assets/icon-192.png", tag: d.tag || undefined, renotify: !!d.tag,
    data: { url: d.url || "/miembro" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/miembro";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
    for (const w of ws) { if (new URL(w.url).origin === self.location.origin && "focus" in w) { w.navigate(url).catch(() => {}); return w.focus(); } }
    return self.clients.openWindow(url);
  }));
});
