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

  // ── Moneda (Gs / USD). Auto por país, con toggle. PAGOPAR cobra en Gs; USD es display. ──
  let _cur = "";
  try { _cur = localStorage.getItem("oli_cur") || ""; } catch (e) {}
  function currency() { return _cur || "PYG"; }
  function setCurrency(c) { _cur = c; try { localStorage.setItem("oli_cur", c); } catch (e) {} }
  function fmtMoney(gsAmount, rate) {
    if (currency() === "USD") return "US$ " + Math.round(gsAmount / (rate || 7300)).toLocaleString("en-US");
    return "₲ " + Number(gsAmount).toLocaleString("es-PY");
  }
  const tt = (k) => (window.OLI_I18N ? window.OLI_I18N.t(k) : k);

  // Precio mostrado por tier (en el idioma y moneda actuales). Cobro anual único.
  function precioTier(t, rate) {
    if (!t.precioAnio || t.precioAnio <= 0) return { big: tt("price_gratis"), small: tt("price_forever") };
    return { big: fmtMoney(t.precioAnio, rate), small: tt("price_year") };
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

  // Genera un QR (data URL) si el generador está disponible.
  function makeQR(text) {
    try { if (!window.qrcode) return ""; const qr = window.qrcode(0, "M"); qr.addData(String(text)); qr.make(); return qr.createDataURL(5, 2); }
    catch (e) { return ""; }
  }

  // Carnet vertical reutilizable (landing + área de miembro). Color por nivel vía .cn--slug.
  function carnet(o) {
    o = o || {};
    const slug = o.tierSlug || "olimpista";
    const nombre = o.nombre || "Tu nombre";
    const nivel = o.tierNombre || "Olimpista";
    const numero = o.numero || "OLI-••••••••";
    const avatar = o.foto
      ? `<img class="cn-photo" src="${o.foto}" alt="" />`
      : `<div class="cn-photo cn-photo-ph">${o.icono || "★"}</div>`;
    const qr = o.qr
      ? `<div class="cn-qr"><img src="${o.qr}" alt="QR de miembro" /></div>`
      : `<div class="cn-qr cn-qr-empty">Tu QR</div>`;
    return `<div class="cn cn--${slug}">
      <div class="cn-head">
        <img class="cn-logo" src="/assets/logo-horizontal.svg" alt="Olimpistas" />
      </div>
      ${avatar}
      <div class="cn-name">${nombre}</div>
      <div class="cn-level">${nivel}</div>
      ${qr}
      <div class="cn-num">${numero}</div>
      <div class="cn-foot">MIEMBRO · OLIMPISTAS</div>
    </div>`;
  }

  // Registrar el Service Worker (PWA) — solo en producción. En localhost se evita
  // para que el cache-first del SW no sirva JS/CSS viejos durante el desarrollo.
  const esLocal = ["localhost", "127.0.0.1", ""].includes(location.hostname);
  if ("serviceWorker" in navigator && !esLocal) {
    // Network-first SW (ver sw.js): cada navegación trae lo último. Sin reload forzado
    // (causaba loops que interrumpían la carga del globo).
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").then((reg) => { try { reg.update(); } catch (e) {} }).catch(() => {});
    });
  } else if ("serviceWorker" in navigator) {
    // Limpieza en dev: si quedó un SW registrado de antes, lo sacamos.
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  }

  // Banner de cookies (una sola vez). Solo usamos cookie esencial de sesión.
  function bannerCookies() {
    try { if (localStorage.getItem("oli_cookies_ok")) return; } catch (e) { return; }
    const T = (k) => (window.OLI_I18N ? window.OLI_I18N.t(k) : k);
    const b = document.createElement("div");
    b.className = "cookie-bar";
    b.innerHTML = `<span>${T("cookie_txt")} <a href="/legal#cookies">${T("cookie_link")}</a>.</span>` +
      `<button class="btn" id="cookieOk">${T("cookie_ok")}</button>`;
    document.body.appendChild(b);
    b.querySelector("#cookieOk").onclick = () => { try { localStorage.setItem("oli_cookies_ok", "1"); } catch (e) {} b.remove(); };
  }

  // Pase de estética + i18n: aplica traducciones, nav "glass" al scroll, aparición de secciones.
  window.addEventListener("DOMContentLoaded", () => {
    if (window.OLI_I18N) window.OLI_I18N.apply();
    bannerCookies();
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

  return { api, gs, precioTier, artGradient, artSvg, toast, yo, makeQR, carnet, currency, setCurrency, fmtMoney };
})();
