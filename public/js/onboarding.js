/* onboarding.js — inscripción guiada, mobile-first, con selfie (cámara) o galería.
   3 instancias: 1) cuenta (con confirmar contraseña)  2) carnet: selfie + ubicación
   + fecha de nacimiento  3) validación de socio (cédula → Plus/Junior por edad).
   Usa OLI (api, carnet, makeQR) y OLI_I18N (t). Llamar OLI_ONB.start(). */
window.OLI_ONB = (function () {
  const { api, carnet, makeQR } = window.OLI;
  const T = (k) => (window.OLI_I18N ? window.OLI_I18N.t(k) : k);
  const LANG = window.OLI_I18N ? window.OLI_I18N.lang() : "es";
  let CONFIG = null, stream = null, fotoData = null, paso = 1, totalPasos = 4, ubicSel = null;
  let pinSel = null, mapaOnb = null; // pin exacto (bandera en el mapa) elegido en instancia 2

  function paises() { return (CONFIG && CONFIG.paises) || []; }

  function el(html) { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; }

  function render() {
    const ob = el(`
      <div class="ob" id="onboarding">
        <div class="ob-top">
          <img class="ob-logo" src="/assets/logo-horizontal.svg?v=88" alt="Olimpistas" />
          <button class="ob-close" id="obClose" aria-label="Cerrar">✕</button>
        </div>
        <div class="ob-dots" id="obDots"></div>
        <div class="ob-body" id="obBody"></div>
      </div>`);
    document.body.appendChild(ob);
    document.body.style.overflow = "hidden";
    ob.querySelector("#obClose").onclick = cerrar;
    pintarDots();
    irPaso(1);
  }
  function cerrar() {
    pararCamara(); destruirMapa();
    const ob = document.getElementById("onboarding");
    if (ob) ob.remove();
    document.body.style.overflow = "";
  }
  function pintarDots() {
    const d = document.getElementById("obDots");
    d.innerHTML = Array.from({ length: totalPasos }, (_, i) =>
      `<i class="${i + 1 <= paso ? "on" : ""}"></i>`).join("");
  }
  function irPaso(n) { paso = n; pintarDots(); ({ 1: pCuenta, 2: pFoto, 3: pUbic, 4: pListo }[n])(); }

  // ── Paso 1: cuenta ──
  function pCuenta() {
    pararCamara();
    const b = document.getElementById("obBody");
    b.innerHTML = `
      <div class="ob-step">
        <h2>${T("ob_cuenta_h")}</h2>
        <p class="ob-sub">${T("ob_cuenta_p")}</p>
        <div class="ob-field"><label>${T("m_nombre")}</label><input id="obNombre" type="text" autocomplete="given-name" /></div>
        <div class="ob-field"><label>${T("m_apellido")}</label><input id="obApellido" type="text" autocomplete="family-name" /></div>
        <div class="ob-field"><label>${T("m_email")}</label><input id="obEmail" type="email" autocomplete="email" /></div>
        <div class="ob-field"><label>${T("m_pass")}</label><div class="pw-wrap"><input id="obPass" type="password" autocomplete="new-password" /><button class="pw-toggle" type="button" aria-label="${T("m_pw_ver")}">👁</button></div></div>
        <div class="ob-field"><label>${T("ob_pass2")}</label><div class="pw-wrap"><input id="obPass2" type="password" autocomplete="new-password" /><button class="pw-toggle" type="button" aria-label="${T("m_pw_ver")}">👁</button></div></div>
        <label class="consent"><input type="checkbox" id="obConsent" />
          <span>${T("consent_1")} <a href="/legal#terminos" target="_blank">${T("consent_terms")}</a> ${T("consent_and")} <a href="/legal#privacidad" target="_blank">${T("consent_privacy")}</a></span></label>
        <p class="ob-err" id="obErr"></p>
        <button class="btn btn-block ob-next" id="obCrear">${T("ob_crear")}</button>
        <p class="ob-switch">${T("m_switch_reg")} <a id="obLogin">${T("m_switch_reg_a")}</a></p>
      </div>`;
    b.querySelector("#obCrear").onclick = crearCuenta;
    b.querySelector("#obLogin").onclick = () => { cerrar(); if (onLogin) onLogin(); };
    window.OLI.wirePasswordToggles(b);
  }
  async function crearCuenta() {
    const nombre = val("obNombre"), apellido = val("obApellido"), email = val("obEmail");
    const password = document.getElementById("obPass").value, password2 = document.getElementById("obPass2").value;
    const err = document.getElementById("obErr"); err.textContent = "";
    if (!nombre || !apellido) { err.textContent = T("ob_nombre_err"); return; }
    if (password.length < 8) { err.textContent = T("ob_pass_corta"); return; }
    if (password !== password2) { err.textContent = T("ob_pass2_err"); return; } // evita errores de tipeo
    if (!document.getElementById("obConsent").checked) { err.textContent = T("consent_err"); return; }
    const btn = document.getElementById("obCrear"); btn.disabled = true;
    try {
      await api("/auth/registro", { method: "POST", body: { email, password, nombre, apellido, ref: window.OLI.ref() } });
      window.OLI.track("Registro", "CompleteRegistration");
      irPaso(2);
    } catch (e) { err.textContent = e.message; btn.disabled = false; }
  }

  // ── Paso 2: foto (selfie en vivo o galería) ──
  function pFoto() {
    const b = document.getElementById("obBody");
    b.innerHTML = `
      <div class="ob-step">
        <h2>${T("ob_foto_h")}</h2>
        <p class="ob-sub">${T("ob_foto_p")}</p>
        <div class="ob-cam" id="obCam">
          <div class="ob-avatar" id="obAvatar">📷</div>
          <video id="obVideo" playsinline autoplay muted hidden></video>
        </div>
        <div class="ob-photo-actions" id="obActions">
          <button class="btn" id="obSelfie">📸 ${T("ob_selfie")}</button>
          <button class="btn btn-ghost" id="obGaleriaBtn">🖼️ ${T("ob_galeria")}</button>
          <input type="file" id="obGaleria" accept="image/*" hidden />
        </div>
        <button class="btn btn-block ob-next" id="obFotoNext">${fotoData ? T("ob_siguiente") : T("ob_omitir")}</button>
      </div>`;
    b.querySelector("#obSelfie").onclick = abrirCamara;
    b.querySelector("#obGaleriaBtn").onclick = () => b.querySelector("#obGaleria").click();
    b.querySelector("#obGaleria").onchange = (e) => { const f = e.target.files[0]; if (f) procesarArchivo(f); };
    b.querySelector("#obFotoNext").onclick = () => irPaso(3);
    if (fotoData) mostrarFoto(fotoData);
  }
  // En MOBILE: cámara nativa sincrónica (dentro del gesto → siempre abre, sin perder
  // el gesto). En DESKTOP: cámara en vivo (getUserMedia), con fallback a input nativo.
  function abrirCamara() {
    const esMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (window.matchMedia && matchMedia("(pointer: coarse)").matches);
    if (esMobile || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return camaraNativa();
    const video = document.getElementById("obVideo"), avatar = document.getElementById("obAvatar");
    const actions = document.getElementById("obActions");
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false }).then((s) => {
      stream = s; video.srcObject = s; video.hidden = false; avatar.hidden = true;
      actions.innerHTML = `<button class="btn" id="obShoot">${T("ob_capturar")}</button><button class="btn btn-ghost" id="obCancel">✕</button>`;
      actions.querySelector("#obShoot").onclick = capturarSelfie;
      actions.querySelector("#obCancel").onclick = () => { pararCamara(); pFoto(); };
    }).catch(() => camaraNativa());
  }
  function camaraNativa() {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*"; inp.capture = "user";
    inp.onchange = (ev) => { const f = ev.target.files && ev.target.files[0]; if (f) procesarArchivo(f); };
    inp.click(); // dentro del gesto del usuario → abre la cámara del teléfono
  }
  function capturarSelfie() {
    const video = document.getElementById("obVideo");
    const c = document.createElement("canvas"); const size = 256; c.width = c.height = size;
    const vw = video.videoWidth, vh = video.videoHeight, min = Math.min(vw, vh);
    const ctx = c.getContext("2d");
    ctx.translate(size, 0); ctx.scale(-1, 1); // espejar (selfie)
    ctx.drawImage(video, (vw - min) / 2, (vh - min) / 2, min, min, 0, 0, size, size);
    fotoData = c.toDataURL("image/jpeg", 0.85);
    pararCamara(); pFoto();
  }
  function procesarArchivo(file) {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); const size = 256; c.width = c.height = size;
      const min = Math.min(img.width, img.height);
      c.getContext("2d").drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, size, size);
      fotoData = c.toDataURL("image/jpeg", 0.85);
      pFoto();
      subirFoto();
    };
    const fr = new FileReader(); fr.onload = () => (img.src = fr.result); fr.readAsDataURL(file);
  }
  function mostrarFoto(data) {
    const av = document.getElementById("obAvatar");
    if (av) { av.innerHTML = `<img src="${data}" alt="" />`; av.classList.add("has-img"); }
    const actions = document.getElementById("obActions");
    if (actions) actions.innerHTML = `<button class="btn btn-ghost" id="obRetomar">↺ ${T("ob_retomar")}</button>`;
    const r = document.getElementById("obRetomar"); if (r) r.onclick = () => { fotoData = null; pFoto(); };
    const next = document.getElementById("obFotoNext"); if (next) next.textContent = T("ob_siguiente");
  }
  async function subirFoto() {
    if (!fotoData) return;
    mostrarFoto(fotoData);
    // No tragar el error: si la foto no se guardó, avisar (antes el usuario creía que sí).
    try { await api("/perfil/foto", { method: "POST", body: { foto: fotoData } }); }
    catch (e) { try { window.OLI && OLI.toast && OLI.toast(T("m_error_generico")); } catch (_) {} }
  }
  function pararCamara() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }

  // Estilo de mapa callejero (para elegir el punto exacto). Mismas fuentes que ya
  // permite la CSP (Esri). El usuario mueve el mapa y el pin queda fijo al centro.
  const ESTILO_CALLE = {
    version: 8,
    sources: { calles: { type: "raster", tileSize: 256, maxzoom: 19, attribution: "Esri",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"] } },
    layers: [{ id: "calles", type: "raster", source: "calles" }],
  };

  // ── Instancia 2 (cont.): ubicación + fecha de nacimiento + bandera en el mapa ──
  function pUbic() {
    pararCamara();
    const opts = '<option value="">—</option>' + paises().map((p) => `<option value="${p.iso}">${p.nombre}</option>`).join("");
    const b = document.getElementById("obBody");
    b.innerHTML = `
      <div class="ob-step">
        <h2>${T("ob_ubic_h")}</h2>
        <p class="ob-sub">${T("ob_ubic_p")}</p>
        <div class="ob-field"><label>${T("ob_pais")}</label><select id="obPais">${opts}</select></div>
        <div class="ob-field"><label>${T("ob_ciudad")}</label><input id="obCiudad" type="text" /></div>
        <div class="ob-field"><label>${T("ob_fechanac")}</label><input id="obFechaNac" type="date" max="${hoyISO()}" /></div>
        <div class="ob-mapa-wrap" id="obMapaWrap">
          <button class="btn btn-ghost btn-block" id="obMapaAbrir" type="button">🚩 ${T("ob_bandera_h")}</button>
          <p class="ob-mapa-sub" style="margin-top:8px">${T("ob_bandera_p")}</p>
        </div>
        <p class="ob-err" id="obUbicErr"></p>
        <button class="btn btn-block ob-next" id="obUbicNext">${T("ob_ubic_guardar")}</button>
        <p class="ob-switch"><a id="obUbicSkip">${T("ob_omitir_completar")}</a></p>
      </div>`;
    // prefill país por IP
    api("/geo").then(({ pais }) => { if (pais && pais.iso) { const s = document.getElementById("obPais"); if (s) s.value = pais.iso; } }).catch(() => {});
    // El mapa (MapLibre) es opt-in: aligera el paso 3 (menos campos visibles a la vez) y
    // evita cargar ~200KB de mapa si el usuario no va a poner su bandera exacta — sigue
    // disponible con un solo tap.
    b.querySelector("#obMapaAbrir").onclick = abrirMapaEx;
    b.querySelector("#obUbicNext").onclick = guardarUbic;
    b.querySelector("#obUbicSkip").onclick = () => { destruirMapa(); irPaso(4); };
  }
  function abrirMapaEx() {
    const wrap = document.getElementById("obMapaWrap");
    if (!wrap) return;
    wrap.innerHTML = `
      <label class="ob-mapa-lbl">🚩 ${T("ob_bandera_h")}</label>
      <p class="ob-mapa-sub">${T("ob_bandera_p")}</p>
      <div class="ob-mapa" id="obMapaEx"><div class="ob-mapa-pin" id="obPin">🚩</div></div>
      <button class="btn btn-ghost btn-block ob-geo" id="obGeo" type="button">📍 ${T("ob_usar_ubic")}</button>
      <p class="ob-mapa-hint" id="obPinHint">${T("ob_bandera_hint")}</p>`;
    wrap.querySelector("#obGeo").onclick = ubicarme;
    initMapaEx();
  }
  function hoyISO() { const d = new Date(); return d.toISOString().slice(0, 10); }

  // Carga MapLibre on-demand (en la landing se carga lazy al scrollear al globo;
  // el onboarding puede dispararse antes, así que lo aseguramos acá).
  function cargarMapLibre() {
    if (window.maplibregl) return Promise.resolve();
    return new Promise((res) => {
      if (!document.querySelector('link[href*="maplibre-gl.css"]')) {
        const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/assets/vendor/maplibre-gl.css"; document.head.appendChild(l);
      }
      const prev = document.querySelector('script[src*="maplibre-gl.js"]');
      if (prev) { prev.addEventListener("load", () => res()); if (window.maplibregl) res(); return; }
      const s = document.createElement("script"); s.src = "/assets/vendor/maplibre-gl.js"; s.onload = () => res(); s.onerror = () => res(); document.head.appendChild(s);
    });
  }
  async function initMapaEx() {
    await cargarMapLibre();
    const ML = window.maplibregl, cont = document.getElementById("obMapaEx");
    if (!ML || !cont) return;
    try {
      mapaOnb = new ML.Map({ container: cont, style: ESTILO_CALLE, center: [-57.63, -25.29], zoom: 12, attributionControl: false });
      mapaOnb.addControl(new ML.NavigationControl({ showCompass: false }), "top-right");
      // El pin vive fijo al centro (CSS). Al mover el mapa, el centro = la bandera.
      const marcar = () => { const c = mapaOnb.getCenter(); pinSel = { lat: c.lat, lng: c.lng }; const h = document.getElementById("obPinHint"); if (h) h.textContent = T("ob_bandera_ok"); };
      mapaOnb.on("moveend", marcar);
    } catch (e) {}
  }
  function destruirMapa() { try { if (mapaOnb) { mapaOnb.remove(); mapaOnb = null; } } catch (e) {} }
  function ubicarme() {
    if (!navigator.geolocation) return;
    const btn = document.getElementById("obGeo"); if (btn) btn.textContent = "…";
    navigator.geolocation.getCurrentPosition(
      (pos) => { const { latitude, longitude } = pos.coords; pinSel = { lat: latitude, lng: longitude }; if (mapaOnb) mapaOnb.flyTo({ center: [longitude, latitude], zoom: 16 }); if (btn) btn.textContent = "📍 " + T("ob_usar_ubic"); },
      () => { if (btn) btn.textContent = "📍 " + T("ob_usar_ubic"); },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }
  async function guardarUbic() {
    const pais = document.getElementById("obPais").value, ciudad = val("obCiudad");
    const fechaNac = document.getElementById("obFechaNac").value;
    const err = document.getElementById("obUbicErr"); if (err) err.textContent = "";
    ubicSel = { iso: pais, ciudad };
    try {
      const body = {};
      if (pais) body.pais = pais; if (ciudad) body.ciudad = ciudad; if (fechaNac) body.fecha_nacimiento = fechaNac;
      // Si puso su bandera en el mapa → punto exacto público (opt-in).
      if (pinSel) { body.lat = pinSel.lat; body.lng = pinSel.lng; body.mostrar_exacto = true; }
      if (Object.keys(body).length) await api("/perfil", { method: "PATCH", body });
    } catch (e) { if (err) { err.textContent = e.message; return; } }
    destruirMapa();
    irPaso(4);
  }

  // ── Carnet listo → entra a su cuenta ──
  async function pListo() {
    pararCamara(); destruirMapa();
    const b = document.getElementById("obBody");
    let c = null;
    try { c = (await api("/carnet")).carnet; } catch (e) {}
    const qr = c ? makeQR(location.origin + "/c/" + encodeURIComponent(c.numero)) : "";
    const carnetHtml = c ? carnet({ tierSlug: c.tierSlug, tierNombre: c.tier, nombre: c.nombre, numero: c.numero, foto: c.foto, qr, iso: c.iso }) : "";
    const hayMundo = !!document.getElementById("mundo");
    b.innerHTML = `
      <div class="ob-step ob-listo">
        <h2>${T("ob_listo_h")}</h2>
        <p class="ob-sub">${T("ob_listo_p")}</p>
        ${carnetHtml}
        <p class="ob-ig-cta">${T("ig_cta")}</p>
        <button class="btn btn-block btn-ig" id="obIG">📸 ${T("ig_compartir")}</button>
        <button class="btn btn-ghost btn-block" id="obIr" style="margin-top:10px">${T("ob_ir")}</button>
        ${hayMundo ? `<button class="btn btn-ghost btn-block" id="obMapa" style="margin-top:10px">${T("ob_ver_mapa")}</button>` : ""}
      </div>`;
    b.querySelector(".cn")?.classList.add("cn-reveal");
    setTimeout(() => { try { window.OLI && OLI.confetti && OLI.confetti(); } catch (e) {} }, 250);
    b.querySelector("#obIG").onclick = async () => {
      const bt = b.querySelector("#obIG"); const o0 = bt.innerHTML; bt.disabled = true; bt.textContent = "…";
      try {
        const pais = (paises().find((p) => p.iso === (ubicSel && ubicSel.iso)) || {}).nombre || "";
        const r = await window.OLI.compartirStory({
          nombre: c ? c.nombre : "", ciudad: (ubicSel && ubicSel.ciudad) || "", pais, iso: c ? c.iso : "", foto: c ? c.foto : "",
          caption: T("ig_caption"), igUrl: "https://instagram.com/olimpistascom",
        });
        if (r && r.downloaded && window.OLI.toast) OLI.toast(T("m_ig_descargado"));
      } catch (e) {} finally { bt.disabled = false; bt.innerHTML = o0; }
    };
    b.querySelector("#obIr").onclick = () => { cerrar(); location.href = "/miembro"; };
    const mapa = b.querySelector("#obMapa");
    if (mapa) mapa.onclick = () => {
      try { sessionStorage.setItem("oli_nuevo", JSON.stringify(ubicSel || {})); } catch (e) {}
      cerrar();
      const m = document.getElementById("mundo");
      if (m) m.scrollIntoView({ behavior: "smooth" });
      setTimeout(() => { if (window.OLI_MUNDO_FOCAR) window.OLI_MUNDO_FOCAR(); }, 1000);
    };
  }

  const val = (id) => (document.getElementById(id)?.value || "").trim();
  let onLogin = null;

  function start(opts) { opts = opts || {}; onLogin = opts.onLogin || null; CONFIG = opts.config || CONFIG; fotoData = null; pinSel = null; render(); }
  return { start, setConfig: (c) => { CONFIG = c; } };
})();
