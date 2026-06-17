/* sw.js — Service Worker de Olimpistas (PWA).
 *
 * Estrategia:
 *  - Estáticos (css/js/assets/manifest) → cache-first (rápido, baja carga al server).
 *  - Navegación (HTML) → network-first con fallback a caché (funciona offline).
 *  - API (/api/*) → SIEMPRE red, nunca caché (datos siempre frescos).
 *
 * El cache-first de estáticos también ayuda a aguantar picos de tráfico: tras la
 * primera carga, los assets salen del dispositivo y no pegan al servidor.
 */
const VERSION = "oli-v3";
const SHELL = [
  "/", "/socio",
  "/css/styles.css", "/js/common.js", "/js/landing.js", "/js/socio.js",
  "/assets/logo.svg", "/assets/hero.svg", "/manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // API → red directa, sin caché.
  if (url.pathname.startsWith("/api")) return;

  // Navegación → network-first, fallback a caché (offline).
  if (request.mode === "navigate") {
    e.respondWith(
      fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(request, copy));
        return res;
      }).catch(() => caches.match(request).then((r) => r || caches.match("/")))
    );
    return;
  }

  // Estáticos → cache-first.
  e.respondWith(
    caches.match(request).then((cached) =>
      cached || fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(request, copy));
        return res;
      })
    )
  );
});
