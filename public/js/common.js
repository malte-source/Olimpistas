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
  function fmtMoney(gsAmount, rate) {
    if (currency() === "USD") return "US$ " + Math.round(gsAmount / (rate || 7300)).toLocaleString("en-US");
    return "₲ " + Number(gsAmount).toLocaleString("es-PY");
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
      btn.addEventListener("click", () => {
        const input = btn.previousElementSibling;
        if (!input) return;
        const showing = input.type === "password";
        input.type = showing ? "text" : "password";
        btn.textContent = showing ? "🙈" : "👁";
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
    const avatar = o.foto
      ? `<img class="cn-photo" src="${o.foto}" alt="" />`
      : `<div class="cn-photo cn-photo-ph">${o.icono || "★"}</div>`;
    const qr = o.qr
      ? `<div class="cn-qr"><img src="${o.qr}" alt="QR de miembro" /></div>`
      : `<div class="cn-qr cn-qr-empty">Tu QR</div>`;
    const iso = (o.iso || "").toLowerCase().trim();
    const flag = /^[a-z]{2}$/.test(iso)
      ? `<img class="cn-flag" src="https://flagcdn.com/${iso}.svg" alt="" loading="lazy" />` : "";
    return `<div class="cn cn--${slug}">
      <div class="cn-head">
        <img class="cn-logo" src="/assets/logo-horizontal.svg?v=38" alt="Olimpistas" />
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
      const tierCol = ({ olimpista: "#3a3a52", kids: "#e94560", premium: "#c9a227", socio: "#c9a227" })[o.tierSlug || "olimpista"] || "#3a3a52";
      const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#14141b"); g.addColorStop(1, "#0b0b0f");
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      const gb = x.createLinearGradient(0, 0, W, 0); gb.addColorStop(0, tierCol); gb.addColorStop(1, "#0b0b0f");
      x.fillStyle = gb; x.fillRect(0, 0, W, 132); x.fillStyle = "#c9a227"; x.fillRect(0, 132, W, 3);
      const logo = await _loadImg("/assets/logo-horizontal.svg?v=45");
      if (logo) { const lw = 300, lh = lw * ((logo.height / logo.width) || 0.215); x.drawImage(logo, (W - lw) / 2, 46, lw, lh); }
      const cx = W / 2, cy = 322, r = 110;
      x.save(); x.beginPath(); x.arc(cx, cy, r, 0, 6.2832); x.closePath(); x.clip();
      const foto = o.foto ? await _loadImg(o.foto) : null;
      if (foto) x.drawImage(foto, cx - r, cy - r, r * 2, r * 2);
      else { x.fillStyle = "#23232c"; x.fillRect(cx - r, cy - r, r * 2, r * 2); x.fillStyle = "#f0d873"; x.font = "bold 92px Arial"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(o.icono || "★", cx, cy); }
      x.restore();
      x.lineWidth = 5; x.strokeStyle = "#c9a227"; x.beginPath(); x.arc(cx, cy, r, 0, 6.2832); x.stroke();
      const iso = (o.iso || "").toLowerCase().trim();
      if (/^[a-z]{2}$/.test(iso)) {
        const fl = await _loadImg("https://flagcdn.com/" + iso + ".svg", true);
        if (fl) { const fr = 34, fx = cx + r - 26, fy = cy + r - 34; x.save(); x.beginPath(); x.arc(fx, fy, fr, 0, 6.2832); x.closePath(); x.clip(); x.drawImage(fl, fx - fr, fy - fr, fr * 2, fr * 2); x.restore(); x.lineWidth = 4; x.strokeStyle = "#fff"; x.beginPath(); x.arc(fx, fy, fr, 0, 6.2832); x.stroke(); }
      }
      x.textAlign = "center"; x.textBaseline = "alphabetic";
      x.fillStyle = "#fff"; x.font = "800 44px Arial"; x.fillText(o.nombre || "Tu nombre", cx, 484);
      x.fillStyle = "#f0d873"; x.font = "700 23px Arial"; x.fillText((o.tierNombre || "Olimpista").toUpperCase(), cx, 520);
      const qs = 230, qx = (W - qs) / 2, qy = 558;
      x.fillStyle = "#fff"; _rr(x, qx - 14, qy - 14, qs + 28, qs + 28, 16); x.fill();
      const qrImg = o.qr ? await _loadImg(o.qr) : null;
      if (qrImg) x.drawImage(qrImg, qx, qy, qs, qs);
      x.fillStyle = "#c6c6d0"; x.font = "600 24px monospace"; x.fillText(o.numero || "OLI-••••••••", cx, qy + qs + 46);
      x.fillStyle = "rgba(255,255,255,.42)"; x.font = "700 15px Arial"; x.fillText("MIEMBRO · OLIMPISTAS", cx, qy + qs + 78);
      // Dirección web (CTA para quien recibe el carnet compartido).
      x.fillStyle = "#f0d873"; x.font = "800 26px Arial"; x.fillText("www.olimpistas.com", cx, H - 34);
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
      const bg = await _loadImg("/assets/hero-mobile.jpg?v=51") || await _loadImg("/assets/hero-desktop.jpg?v=51");
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
      const logo = await _loadImg("/assets/logo-horizontal.svg?v=49");
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
        <button class="foto-x" type="button" aria-label="Cerrar">✕</button>
        <div class="foto-vis"><div class="foto-ph" id="fph">📷</div><video id="fvid" playsinline autoplay muted hidden></video></div>
        <div class="foto-acts" id="facts">
          <button class="btn" id="fcam" type="button">📸 Tomar foto</button>
          <button class="btn btn-ghost" id="fgalb" type="button">🖼️ Galería</button>
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
        $("#facts").innerHTML = `<button class="btn" id="fshoot" type="button">Capturar</button><button class="btn btn-ghost" id="fcancel" type="button">✕</button>`;
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

  return { api, esc, gs, precioTier, artGradient, artSvg, toast, yo, makeQR, carnet, carnetImagen, storyImagen, compartirStory, currency, setCurrency, fmtMoney, confetti, fotoModal, modal, pedirCedula, wirePasswordToggles, ref, refLink, track };
})();
