/* common.js — helpers compartidos entre landing y área de socio. */
window.OLI = (function () {
  async function api(path, opts = {}) {
    const res = await fetch("/api" + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* sin cuerpo */ }
    if (!res.ok) throw new Error((data && data.error) || `Error ${res.status}`);
    return data;
  }

  // Formatea guaraníes: 49000 → "₲ 49.000"
  function gs(n) {
    if (n == null) return "";
    return "₲ " + Number(n).toLocaleString("es-PY");
  }

  // Precio mostrado por tier. Cobro anual único; gratis = 0.
  function precioTier(t) {
    if (!t.precioAnio || t.precioAnio <= 0) return { big: "Gratis", small: "para siempre" };
    return { big: gs(t.precioAnio), small: "por año" };
  }

  // Art determinista para tarjetas/thumbs según una semilla (id/slug).
  const PALETAS = [
    ["#c9a227", "#7a5f10"], ["#3a3a52", "#14141b"], ["#2a2f45", "#0d1020"],
    ["#e94560", "#7a1f2e"], ["#1d3a24", "#0a1710"], ["#2b4a6f", "#0e1c2c"],
  ];
  function artGradient(seed) {
    let h = 0; for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const [a, b] = PALETAS[h % PALETAS.length];
    return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
  }
  function artSvg(seed, label, icon) {
    const grad = artGradient(seed);
    return `<div style="width:100%;height:100%;background:${grad};display:flex;align-items:center;
      justify-content:center;color:rgba(255,255,255,.9);font-weight:700;position:relative">
      <span style="font-size:34px;opacity:.85">${icon || "▦"}</span></div>`;
  }

  function toast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg; el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2600);
  }

  async function yo() {
    try { return await api("/auth/yo"); } catch { return null; }
  }

  // Registrar el Service Worker (PWA) — solo en producción. En localhost se evita
  // para que el cache-first del SW no sirva JS/CSS viejos durante el desarrollo.
  const esLocal = ["localhost", "127.0.0.1", ""].includes(location.hostname);
  if ("serviceWorker" in navigator && !esLocal) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  } else if ("serviceWorker" in navigator) {
    // Limpieza en dev: si quedó un SW registrado de antes, lo sacamos.
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  }

  // Pase de estética: nav "glass" al scrollear + aparición de secciones al entrar en viewport.
  window.addEventListener("DOMContentLoaded", () => {
    const nav = document.querySelector(".nav");
    if (nav) {
      const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 30);
      onScroll();
      window.addEventListener("scroll", onScroll, { passive: true });
    }
    const els = document.querySelectorAll(".section, .why-item");
    if ("IntersectionObserver" in window && els.length) {
      els.forEach((e) => e.classList.add("reveal"));
      const io = new IntersectionObserver((ents) => {
        ents.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
      }, { threshold: 0.06, rootMargin: "0px 0px -6% 0px" });
      els.forEach((e) => io.observe(e));
    }
  });

  return { api, gs, precioTier, artGradient, artSvg, toast, yo };
})();
