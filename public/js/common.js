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

  // Escapa texto para interpolar seguro en HTML (anti-XSS). Usar SIEMPRE con datos
  // de socio (nombre, ciudad, etc.) antes de meterlos en innerHTML/setHTML.
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
  // ── Tema (claro/oscuro). Mismo patrón que idioma/moneda: localStorage + toggle manual.
  // Default oscuro explícito (no prefers-color-scheme) para no cambiar nada hasta que se toque a mano. ──
  let _theme = "";
  try { _theme = localStorage.getItem("oli_theme") || ""; } catch (e) {}
  function theme() { return _theme || "dark"; }
  function setTheme(t) {
    _theme = t;
    try { localStorage.setItem("oli_theme", t); } catch (e) {}
    document.documentElement.setAttribute("data-theme", t);
  }
  function initThemeToggle(btnId) {
    document.documentElement.setAttribute("data-theme", theme());
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const paint = () => { btn.textContent = theme() === "light" ? "Oscuro" : "Claro"; };
    paint();
    btn.addEventListener("click", () => { setTheme(theme() === "light" ? "dark" : "light"); paint(); });
  }

  // ── Íconos — F1.2 "Iconografía": 40 SVG de línea (grilla 24, trazo 1.5, currentColor) que
  // reemplazan los emoji del producto. Self-hosteados: la CSP no permite CDNs de íconos.
  // Familia inspirada en una base geométrica abierta, ajustada al trazo/terminales del sistema.
  const ICON_PATHS = {
    // navegación
    house: '<path d="M3 11 12 4l9 7"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/>',
    "credit-card": '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-2 6-6 2 2-6 6-2z"/>',
    tag: '<path d="M3 3h7l11 11-7 7L3 10V3z"/><circle cx="8" cy="8" r="1.2"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/>',
    bell: '<path d="M6 10a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    "log-out": '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M15 16l4-4-4-4"/><path d="M19 12H9"/>',
    // territorios
    gavel: '<path d="M13 10l6.5-6.5 3 3L16 13z"/><path d="M9 13l4 4"/><path d="M11 15l-8 8"/><path d="M3 21h6"/>',
    gift: '<rect x="4" y="8" width="16" height="12" rx="1"/><path d="M4 12h16M12 8v12"/><path d="M9 8a2.5 2.5 0 0 1 0-5c1.5 0 3 2 3 5"/><path d="M15 8a2.5 2.5 0 0 0 0-5c-1.5 0-3 2-3 5"/>',
    ticket: '<path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8z"/><path d="M9 5v14"/>',
    play: '<path d="M6 4l14 8-14 8V4z"/>',
    store: '<path d="M3 9l1-5h16l1 5"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    "shield-check": '<path d="M12 3l7 3v6c0 5-3.5 7.5-7 9-3.5-1.5-7-4-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0V4z"/><path d="M6 5H4a2 2 0 0 0 2 4M18 5h2a2 2 0 0 1-2 4"/><path d="M10 14v3M14 14v3M8 20h8"/>',
    // acciones
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M4 12l5 5L20 6"/>',
    x: '<path d="M5 5l14 14M19 5L5 19"/>',
    "share-2": '<circle cx="18" cy="5" r="2.2"/><circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="19" r="2.2"/><path d="M8 10.8l8-4.6M8 13.2l8 4.6"/>',
    link: '<path d="M10 14a4 4 0 0 0 6 0l2-2a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-2 2a4 4 0 0 0 6 6l1-1"/>',
    download: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M4 19h16"/>',
    camera: '<path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
    pencil: '<path d="M3 21l4-1 11-11-3-3L4 17l-1 4z"/><path d="M14 6l3 3"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.5-4.5"/>',
    "sliders-horizontal": '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h13M21 18h0"/><circle cx="14" cy="6" r="1.6"/><circle cx="7" cy="12" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
    "chevron-right": '<path d="M9 5l7 7-7 7"/>',
    "arrow-left": '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.5 3-5.5 6-5.5s6 2 6 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.3c2.4.4 4.5 2 4.5 5.7"/>',
    languages: '<path d="M4 5h9M8.5 3v2M4 9a10 10 0 0 0 7 3M11 5a9 9 0 0 1-6 7"/><path d="M14 21l4-9 4 9"/><path d="M15.2 18h5.6"/>',
    "external-link": '<path d="M10 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4"/><path d="M14 4h6v6"/><path d="M20 4l-9 9"/>',
    // datos y estados
    hourglass: '<path d="M6 3h12M6 21h12"/><path d="M7 3c0 5 4 6 5 9-1 3-5 4-5 9M17 3c0 5-4 6-5 9 1 3 5 4 5 9"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    "map-pin": '<path d="M12 21s7-6.5 7-11.5A7 7 0 0 0 5 9.5C5 14.5 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.4"/>',
    coins: '<circle cx="9" cy="9" r="6"/><path d="M15.5 10.5a6 6 0 1 1 0 9 6 6 0 0 1-6-6"/>',
    receipt: '<path d="M6 3h12v18l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3L6 21V3z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    "qr-code": '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v3M14 20h1M20 20h1"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="8" r="1"/>',
    "circle-alert": '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><circle cx="12" cy="16.5" r="1"/>',
  };
  // icon(name, {size}) → <svg> inline con currentColor, listo para insertar en innerHTML.
  function icon(name, opts) {
    const size = (opts && opts.size) || 24;
    const body = ICON_PATHS[name];
    if (!body) return "";
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block">${body}</svg>`;
  }

  const tt = (k) => (window.OLI_I18N ? window.OLI_I18N.t(k) : k);

  // Precio mostrado por tier (en el idioma y moneda actuales). Cobro anual único.
  function precioTier(t, rate) {
    if (!t.precioAnio || t.precioAnio <= 0) return { big: tt("price_gratis"), small: tt("price_forever") };
    // DOS precios independientes: Gs (precioAnio) y USD (precioUSD). NO se convierten
    // entre sí. El selector de moneda muestra uno u otro tal cual está definido.
    const big = currency() === "USD"
      ? "US$ " + (t.precioUSD != null ? Number(t.precioUSD).toFixed(2) : Math.round(t.precioAnio / (rate || 7300)))
      : "₲ " + Number(t.precioAnio).toLocaleString("es-PY");
    return { big, small: tt("price_year") };
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

  // Cablea botones .pw-toggle (mostrar/ocultar) para el input de contraseña inmediatamente
  // anterior en el DOM. Idempotente: se puede llamar de nuevo tras re-renderizar el form.
  function wirePasswordToggles(root) {
    (root || document).querySelectorAll(".pw-toggle").forEach((btn) => {
      if (btn._pwWired) return;
      btn._pwWired = true;
      btn.innerHTML = icon("eye", { size: 18 });
      btn.addEventListener("click", () => {
        const input = btn.previousElementSibling;
        if (!input) return;
        const showing = input.type === "password";
        input.type = showing ? "text" : "password";
        btn.innerHTML = icon("eye", { size: 18 });
      });
    });
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
    // Mismo carnet en los 4 niveles (Brandbook): el placeholder de foto es un solo
    // ícono universal, no un glifo distinto por nivel.
    const avatar = o.foto
      ? `<img class="cn-photo" src="${o.foto}" alt="" />`
      : `<div class="cn-photo cn-photo-ph">${o.icono || icon("user", { size: 34 })}</div>`;
    const qr = o.qr
      ? `<div class="cn-qr"><img src="${o.qr}" alt="QR de miembro" /></div>`
      : `<div class="cn-qr cn-qr-empty">Tu QR</div>`;
    const iso = (o.iso || "").toLowerCase().trim();
    const flag = /^[a-z]{2}$/.test(iso)
      ? `<img class="cn-flag" src="https://flagcdn.com/${iso}.svg" alt="" loading="lazy" />` : "";
    return `<div class="cn cn--${slug}">
      <div class="cn-head">
        <img class="cn-logo" src="/assets/logo-horizontal.svg?v=88" alt="Olimpistas" />
      </div>
      <div class="cn-avatar-wrap">${avatar}${flag}</div>
      <div class="cn-name">${esc(nombre)}</div>
      <div class="cn-level">${esc(nivel)}</div>
      ${qr}
      <div class="cn-num">${numero}</div>
      <div class="cn-foot">MIEMBRO · OLIMPISTAS</div>
      <div class="cn-shine" aria-hidden="true"></div>
    </div>`;
  }

  // Carga una imagen (Promise). crossOrigin para no "tintar" el canvas (flagcdn manda CORS).
  function _loadImg(src, cross) {
    return new Promise((res) => { const i = new Image(); if (cross) i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  }
  function _rr(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }

  // Renderiza el carnet a PNG (Blob) para COMPARTIR como imagen (no la página).
  // Devuelve null si algo falla (el caller cae a compartir la URL).
  async function carnetImagen(o) {
    o = o || {};
    try {
      const W = 660, H = 940;
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const x = cv.getContext("2d");
      // Filete por nivel — el único diferenciador de color, igual que en el carnet en pantalla
      // (.cn::after / --tier-stripe). El resto del carnet es idéntico en los 4 niveles.
      const tierCol = ({ olimpista: "#c9c7c1", kids: "#55534e", premium: "#e8dcb8", socio: "#b08d2e" })[o.tierSlug || "olimpista"] || "#c9c7c1";
      const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#14141b"); g.addColorStop(1, "#0b0b0f");
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      x.fillStyle = "#18181f"; x.fillRect(0, 0, W, 132); x.fillStyle = "rgba(255,255,255,.12)"; x.fillRect(0, 132, W, 2);
      const logo = await _loadImg("/assets/logo-horizontal.svg?v=88");
      if (logo) { const lw = 300, lh = lw * ((logo.height / logo.width) || 0.215); x.drawImage(logo, (W - lw) / 2, 46, lw, lh); }
      const cx = W / 2, cy = 322, r = 110;
      x.save(); x.beginPath(); x.arc(cx, cy, r, 0, 6.2832); x.closePath(); x.clip();
      const foto = o.foto ? await _loadImg(o.foto) : null;
      if (foto) x.drawImage(foto, cx - r, cy - r, r * 2, r * 2);
      else {
        // Mismo placeholder en los 4 niveles: un ícono de persona dibujado a mano
        // (canvas no puede pintar el SVG del set — nada de emoji ni glifos tampoco acá).
        x.fillStyle = "#23232c"; x.fillRect(cx - r, cy - r, r * 2, r * 2);
        x.fillStyle = "#fff";
        x.beginPath(); x.arc(cx, cy - r * 0.32, r * 0.26, 0, 6.2832); x.fill();
        x.beginPath(); x.arc(cx, cy + r * 0.95, r * 0.78, 0, 6.2832); x.fill();
      }
      x.restore();
      x.lineWidth = 5; x.strokeStyle = "rgba(255,255,255,.25)"; x.beginPath(); x.arc(cx, cy, r, 0, 6.2832); x.stroke();
      const iso = (o.iso || "").toLowerCase().trim();
      if (/^[a-z]{2}$/.test(iso)) {
        const fl = await _loadImg("https://flagcdn.com/" + iso + ".svg", true);
        if (fl) { const fr = 34, fx = cx + r - 26, fy = cy + r - 34; x.save(); x.beginPath(); x.arc(fx, fy, fr, 0, 6.2832); x.closePath(); x.clip(); x.drawImage(fl, fx - fr, fy - fr, fr * 2, fr * 2); x.restore(); x.lineWidth = 4; x.strokeStyle = "#fff"; x.beginPath(); x.arc(fx, fy, fr, 0, 6.2832); x.stroke(); }
      }
      x.textAlign = "center"; x.textBaseline = "alphabetic";
      x.fillStyle = "#fff"; x.font = "800 44px Arial"; x.fillText(o.nombre || "Tu nombre", cx, 484);
      x.fillStyle = "rgba(255,255,255,.85)"; x.font = "700 23px Arial"; x.fillText((o.tierNombre || "Olimpista").toUpperCase(), cx, 520);
      const qs = 230, qx = (W - qs) / 2, qy = 558;
      x.fillStyle = "#fff"; _rr(x, qx - 14, qy - 14, qs + 28, qs + 28, 16); x.fill();
      const qrImg = o.qr ? await _loadImg(o.qr) : null;
      if (qrImg) x.drawImage(qrImg, qx, qy, qs, qs);
      x.fillStyle = "#c6c6d0"; x.font = "600 24px monospace"; x.fillText(o.numero || "OLI-••••••••", cx, qy + qs + 46);
      x.fillStyle = "rgba(255,255,255,.42)"; x.font = "700 15px Arial"; x.fillText("MIEMBRO · OLIMPISTAS", cx, qy + qs + 78);
      // Dirección web (CTA para quien recibe el carnet compartido).
      x.fillStyle = "#fff"; x.font = "800 26px Arial"; x.fillText("www.olimpistas.com", cx, H - 34);
      // Filete inferior por nivel — mismo color que .cn::after en pantalla.
      x.fillStyle = tierCol; x.fillRect(0, H - 8, W, 8);
      return await new Promise((res) => cv.toBlob((b) => res(b), "image/png", 0.92));
    } catch (e) { return null; }
  }

  // Gráfica de ANUNCIO para Instagram Stories (1080×1920) — "ya soy Olimpista".
  // Selfie protagonista + nombre + ciudad/país + banderita + logo oficial + CTA.
  async function storyImagen(o) {
    o = o || {};
    try {
      const W = 1080, H = 1920, cx = W / 2;
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const x = cv.getContext("2d");
      x.fillStyle = "#0b0b0f"; x.fillRect(0, 0, W, H);
      // Fondo: la hinchada del Decano (cover) + velo oscuro para legibilidad.
      const bg = await _loadImg("/assets/hero-mobile.jpg?v=88") || await _loadImg("/assets/hero-desktop.jpg?v=88");
      if (bg && bg.width) {
        const sc = Math.max(W / bg.width, H / bg.height);
        const bw = bg.width * sc, bh = bg.height * sc;
        x.drawImage(bg, (W - bw) / 2, (H - bh) / 2, bw, bh);
        const g = x.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, "rgba(11,11,15,.93)"); g.addColorStop(0.30, "rgba(11,11,15,.60)");
        g.addColorStop(0.60, "rgba(11,11,15,.74)"); g.addColorStop(1, "rgba(11,11,15,.96)");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
      }
      x.fillStyle = "rgba(21,19,28,.86)"; x.fillRect(0, 0, W, 300);
      x.fillStyle = "#c9a227"; x.fillRect(0, 300, W, 4);
      // Logo OFICIAL (escudo + OLIMPISTAS.com).
      const logo = await _loadImg("/assets/logo-horizontal.svg?v=88");
      if (logo) { const lw = 520, lh = lw * ((logo.height / logo.width) || 0.215); x.drawImage(logo, (W - lw) / 2, 95, lw, lh); }
      // Selfie protagonista.
      const cy = 645, r = 215;
      x.save(); x.beginPath(); x.arc(cx, cy, r, 0, 6.2832); x.closePath(); x.clip();
      const foto = o.foto ? await _loadImg(o.foto) : null;
      x.textAlign = "center";
      if (foto) x.drawImage(foto, cx - r, cy - r, r * 2, r * 2);
      else { x.fillStyle = "#23232c"; x.fillRect(cx - r, cy - r, r * 2, r * 2); x.fillStyle = "#f0d873"; x.font = "bold 190px Arial"; x.textBaseline = "middle"; x.fillText((o.nombre || "O").trim().charAt(0).toUpperCase(), cx, cy); x.textBaseline = "alphabetic"; }
      x.restore();
      x.lineWidth = 10; x.strokeStyle = "#c9a227"; x.beginPath(); x.arc(cx, cy, r, 0, 6.2832); x.stroke();
      // Banderita en la selfie.
      const iso = (o.iso || "").toLowerCase().trim();
      if (/^[a-z]{2}$/.test(iso)) {
        const fl = await _loadImg("https://flagcdn.com/" + iso + ".svg", true);
        if (fl) { const fr = 60, fx = cx + r - 58, fy = cy + r - 58; x.save(); x.beginPath(); x.arc(fx, fy, fr, 0, 6.2832); x.closePath(); x.clip(); x.drawImage(fl, fx - fr, fy - fr, fr * 2, fr * 2); x.restore(); x.lineWidth = 8; x.strokeStyle = "#0b0b0f"; x.beginPath(); x.arc(fx, fy, fr, 0, 6.2832); x.stroke(); x.lineWidth = 3; x.strokeStyle = "#fff"; x.beginPath(); x.arc(fx, fy, fr - 2, 0, 6.2832); x.stroke(); }
      }
      // Anuncio. (re-centramos: restore() reseteó textAlign a "start")
      x.textAlign = "center"; x.textBaseline = "alphabetic";
      x.fillStyle = "#f0d873"; x.font = "700 32px Arial"; try { x.letterSpacing = "8px"; } catch (e) {}
      x.fillText("ME SUMÉ AL DECANO", cx, 990); try { x.letterSpacing = "0px"; } catch (e) {}
      x.fillStyle = "#fff"; x.font = "900 96px Arial"; x.fillText("SOY OLIMPISTA", cx, 1170);
      x.font = "54px Arial"; x.fillText("🤍 🖤 🤍", cx, 1260);
      x.fillStyle = "#fff"; x.font = "800 56px Arial"; x.fillText(o.nombre || "Olimpista", cx, 1400);
      const lugar = [o.ciudad, o.pais].filter(Boolean).join(", ") || o.pais || "";
      if (lugar) { x.fillStyle = "#c6c6d0"; x.font = "600 40px Arial"; x.fillText("📍 " + lugar, cx, 1465); }
      // CTA pie.
      x.fillStyle = "rgba(255,255,255,.6)"; x.font = "600 33px Arial"; x.fillText("Sumate al mundo del Decano, estés donde estés", cx, 1670);
      x.fillStyle = "#f0d873"; x.font = "800 62px Arial"; x.fillText("www.olimpistas.com", cx, 1755);
      x.fillStyle = "rgba(255,255,255,.55)"; x.font = "600 34px Arial"; x.fillText("@olimpistascom · #SoyOlimpista", cx, 1815);
      return await new Promise((res) => cv.toBlob((b) => res(b), "image/png", 0.92));
    } catch (e) { return null; }
  }

  // Genera la gráfica de story y la comparte (Web Share con archivo) o la descarga
  // + abre Instagram. Copia el caption al portapapeles. o: {nombre,ciudad,pais,iso,foto,caption,igUrl}
  async function compartirStory(o) {
    o = o || {};
    const blob = await storyImagen(o);
    if (!blob) return { ok: false };
    const file = new File([blob], "soy-olimpista.png", { type: "image/png" });
    try { if (navigator.clipboard && o.caption) await navigator.clipboard.writeText(o.caption); } catch (e) {}
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Soy Olimpista", text: o.caption || "" }); return { ok: true, shared: true }; }
      catch (e) { return { ok: false, cancel: true }; }
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "soy-olimpista.png"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    try { window.open(o.igUrl || "https://instagram.com/olimpistascom", "_blank"); } catch (e) {}
    return { ok: true, downloaded: true };
  }

  // Confeti dorado/blanco/negro (canvas, sin librería). Para el momento "¡Ya sos Olimpista!".
  function confetti(opts) {
    opts = opts || {};
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const colors = opts.colors || ["#c9a227", "#e7c64b", "#ffffff", "#1a1a1a"];
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cv = document.createElement("canvas"); cv.className = "oli-confetti";
    document.body.appendChild(cv);
    const ctx = cv.getContext("2d");
    let W, H;
    const resize = () => { W = cv.width = innerWidth * dpr; H = cv.height = innerHeight * dpr; cv.style.width = innerWidth + "px"; cv.style.height = innerHeight + "px"; };
    resize();
    const N = opts.count || 150, parts = [];
    for (let i = 0; i < N; i++) parts.push({
      x: W * (0.25 + 0.5 * Math.random()), y: H * (0.15 + 0.1 * Math.random()),
      vx: (Math.random() - 0.5) * 15 * dpr, vy: (Math.random() * -13 - 5) * dpr, g: 0.36 * dpr,
      w: (5 + Math.random() * 7) * dpr, h: (7 + Math.random() * 9) * dpr,
      rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.45, c: colors[i % colors.length],
    });
    let t0 = null;
    function frame(ts) {
      if (!t0) t0 = ts; const dt = ts - t0;
      ctx.clearRect(0, 0, W, H);
      let alive = false;
      for (const p of parts) {
        p.vy += p.g; p.x += p.vx; p.y += p.vy; p.vx *= 0.992; p.rot += p.vr;
        if (p.y < H + 40) alive = true;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, 1 - dt / 3000); ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      }
      if (alive && dt < 3400) requestAnimationFrame(frame); else cv.remove();
    }
    requestAnimationFrame(frame);
  }

  // Tilt 3D + brillo en los carnets (.cn), en TODOS lados (landing, onboarding, miembro).
  // Delegado en document → funciona también con carnets renderizados dinámicamente.
  (function tilt3D() {
    const fino = window.matchMedia && matchMedia("(hover: hover) and (pointer: fine)").matches;
    const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fino || reduce) return;
    let cur = null;
    const reset = (el) => { if (el) el.style.transform = ""; };
    document.addEventListener("pointermove", (e) => {
      const cn = e.target.closest && e.target.closest(".cn");
      if (cn !== cur) { reset(cur); cur = cn; }
      if (!cn) return;
      const r = cn.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      cn.style.transform = `perspective(900px) rotateY(${px * 11}deg) rotateX(${-py * 11}deg) translateY(-5px)`;
    }, { passive: true });
    document.addEventListener("pointerleave", () => { reset(cur); cur = null; }, true);
  })();

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

  // Selector de foto reutilizable: cámara en vivo (selfie) o galería. Devuelve dataURL 256px.
  function fotoModal(onFoto) {
    let stream = null;
    const ov = document.createElement("div");
    ov.className = "foto-modal";
    ov.innerHTML = `
      <div class="foto-card">
        <button class="foto-x" type="button" aria-label="Cerrar">${icon("x", { size: 18 })}</button>
        <div class="foto-vis"><div class="foto-ph" id="fph">${icon("camera", { size: 56 })}</div><video id="fvid" playsinline autoplay muted hidden></video></div>
        <div class="foto-acts" id="facts">
          <button class="btn" id="fcam" type="button">${icon("camera", { size: 18 })} Tomar foto</button>
          <button class="btn btn-ghost" id="fgalb" type="button">${icon("camera", { size: 18 })} Galería</button>
          <input type="file" id="fgal" accept="image/*" hidden />
        </div>
      </div>`;
    document.body.appendChild(ov);
    const $ = (s) => ov.querySelector(s);
    const cerrar = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); ov.remove(); };
    $(".foto-x").onclick = cerrar;
    ov.addEventListener("click", (e) => { if (e.target === ov) cerrar(); });
    const esMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (window.matchMedia && matchMedia("(pointer: coarse)").matches);
    $("#fgalb").onclick = () => $("#fgal").click();
    $("#fgal").onchange = (e) => { const f = e.target.files[0]; if (f) procesar(f); };
    // En mobile: cámara nativa del teléfono (sincrónico → siempre abre, sin fricción de permisos).
    // En desktop: cámara en vivo dentro de la página.
    $("#fcam").onclick = () => {
      if (esMobile || !navigator.mediaDevices?.getUserMedia) return camaraNativa();
      camaraEnVivo();
    };
    function cuadrar(src, w, h) {
      const c = document.createElement("canvas"), s = 256; c.width = c.height = s;
      const m = Math.min(w, h), x = c.getContext("2d");
      x.drawImage(src, (w - m) / 2, (h - m) / 2, m, m, 0, 0, s, s);
      return c.toDataURL("image/jpeg", 0.85);
    }
    function camaraNativa() {
      const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*"; inp.capture = "user";
      inp.onchange = (ev) => { const f = ev.target.files && ev.target.files[0]; if (f) procesar(f); };
      inp.click(); // dentro del gesto del usuario → abre la cámara del teléfono
    }
    function camaraEnVivo() {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false }).then((s) => {
        stream = s; const v = $("#fvid"); v.srcObject = s; v.hidden = false; $("#fph").hidden = true;
        $("#facts").innerHTML = `<button class="btn" id="fshoot" type="button">Capturar</button><button class="btn btn-ghost" id="fcancel" type="button">${icon("x", { size: 18 })}</button>`;
        $("#fshoot").onclick = capturar; $("#fcancel").onclick = cerrar;
      }).catch(() => camaraNativa());
    }
    function capturar() {
      const v = $("#fvid"), c = document.createElement("canvas"), s = 256; c.width = c.height = s;
      const vw = v.videoWidth, vh = v.videoHeight, m = Math.min(vw, vh), x = c.getContext("2d");
      x.translate(s, 0); x.scale(-1, 1); x.drawImage(v, (vw - m) / 2, (vh - m) / 2, m, m, 0, 0, s, s);
      finalizar(c.toDataURL("image/jpeg", 0.85));
    }
    function procesar(file) {
      const img = new Image();
      img.onload = () => finalizar(cuadrar(img, img.width, img.height));
      const fr = new FileReader(); fr.onload = () => (img.src = fr.result); fr.readAsDataURL(file);
    }
    function finalizar(dataUrl) { cerrar(); if (onFoto) onFoto(dataUrl); }
  }

  // ── Modal ACCESIBLE reutilizable ────────────────────────────────────────────
  // Crea overlay .oli-modal-bg > .oli-modal[role=dialog, aria-modal], mueve el foco al
  // primer control, ATRAPA Tab dentro, cierra con Escape y RESTAURA el foco al cerrar.
  // `inner` = HTML del contenido (con un <h3>/<h4> como título). Devuelve { root, close }.
  function modal(inner, opts = {}) {
    const prevFocus = document.activeElement;
    const bg = document.createElement("div");
    bg.className = "oli-modal-bg";
    const labId = "mdl_" + Math.random().toString(36).slice(2, 8);
    bg.innerHTML = `<div class="oli-modal" role="dialog" aria-modal="true" aria-labelledby="${labId}">${inner}</div>`;
    const root = bg.firstElementChild;
    const h = root.querySelector("h3, h4"); if (h && !h.id) h.id = labId;
    document.body.appendChild(bg);
    const focusables = () => Array.prototype.slice.call(root.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    let closed = false;
    const close = () => {
      if (closed) return; closed = true;
      document.removeEventListener("keydown", onKey, true);
      bg.remove();
      if (opts.onClose) { try { opts.onClose(); } catch (e) {} }
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) {} }
    };
    function onKey(e) {
      if (e.key === "Escape" && opts.dismissable !== false) { e.preventDefault(); close(); return; }
      if (e.key === "Tab") {
        const f = focusables(); if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKey, true);
    if (opts.dismissable !== false) bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
    setTimeout(() => { const f = focusables(); if (f.length) f[0].focus(); }, 40);
    return { root, close };
  }

  // Pide la cédula con un modal propio (reemplaza window.prompt). Promise<string|null>.
  function pedirCedula(titulo) {
    return new Promise((resolve) => {
      let done = false;
      const { root, close } = modal(
        `<h3>${esc(titulo || tt("m_cedula_pago") || "Ingresá tu cédula")}</h3>
         <input id="mdlCed" type="text" inputmode="numeric" autocomplete="off" placeholder="${tt("ob_cedula_ph") || "Tu cédula"}" />
         <p class="err" id="mdlCedErr"></p>
         <button class="btn btn-block" id="mdlCedOk">${tt("ob_validar") || "Continuar"}</button>
         <button class="btn btn-ghost btn-block" id="mdlCedX" style="margin-top:8px">${tt("up_cerrar") || "Cancelar"}</button>`,
        { onClose: () => { if (!done) resolve(null); } });
      const inp = root.querySelector("#mdlCed");
      const ok = () => {
        const c = (inp.value || "").replace(/\D/g, "");
        if (!c) { root.querySelector("#mdlCedErr").textContent = tt("ob_cedula_err") || "Ingresá tu cédula"; return; }
        done = true; resolve(c); close();
      };
      root.querySelector("#mdlCedOk").onclick = ok;
      root.querySelector("#mdlCedX").onclick = () => close();
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
    });
  }

  // ── Referidos: capturar ?ref= al entrar y recordarlo hasta el registro ──
  (function () {
    try {
      const r = new URLSearchParams(location.search).get("ref");
      if (r) sessionStorage.setItem("oli_ref", String(r).trim().slice(0, 16));
    } catch (e) {}
  })();
  function ref() { try { return sessionStorage.getItem("oli_ref") || ""; } catch (e) { return ""; } }
  // Link de invitación del socio (para compartir): www.olimpistas.com/?ref=<su_codigo>
  function refLink(codigo) { return "https://www.olimpistas.com/?ref=" + encodeURIComponent(codigo || ""); }

  // Conversiones: un objetivo en Plausible (medición para vos) + un evento estándar en Meta Pixel
  // (para optimizar ads). Best-effort: si alguno no está, no rompe. fbEvent = nombre estándar de Meta.
  // Nombre del evento en GA4 según el evento estándar de Meta (o el goal en minúsculas).
  const GA_EV = { CompleteRegistration: "sign_up", InitiateCheckout: "begin_checkout", Purchase: "purchase" };
  function track(goal, fbEvent, fbParams) {
    try { if (window.plausible) window.plausible(goal); } catch (e) {}
    try { if (window.fbq && fbEvent) window.fbq("track", fbEvent, fbParams || {}); } catch (e) {}
    try { if (window.gtag) window.gtag("event", GA_EV[fbEvent] || String(goal || "event").toLowerCase(), fbParams || {}); } catch (e) {}
  }

  return { api, esc, gs, precioTier, artGradient, artSvg, toast, yo, makeQR, carnet, carnetImagen, storyImagen, compartirStory, currency, setCurrency, confetti, fotoModal, modal, pedirCedula, wirePasswordToggles, ref, refLink, track, theme, setTheme, initThemeToggle, icon };
})();
