/* onboarding.js — inscripción guiada, mobile-first, con selfie (cámara) o galería.
   Pasos: 1) cuenta  2) foto  3) ubicación  4) carnet listo.
   Usa OLI (api, carnet, makeQR) y OLI_I18N (t). Llamar OLI_ONB.start(). */
window.OLI_ONB = (function () {
  const { api, carnet, makeQR } = window.OLI;
  const T = (k) => (window.OLI_I18N ? window.OLI_I18N.t(k) : k);
  const LANG = window.OLI_I18N ? window.OLI_I18N.lang() : "es";
  let CONFIG = null, stream = null, fotoData = null, paso = 1, totalPasos = 4, ubicSel = null, reconocido = false;

  function paises() { return (CONFIG && CONFIG.paises) || []; }

  function el(html) { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; }

  function render() {
    const ob = el(`
      <div class="ob" id="onboarding">
        <div class="ob-top">
          <img class="ob-logo" src="/assets/logo-horizontal.svg" alt="Olimpistas" />
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
    pararCamara();
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
        <div class="ob-field"><label>${T("m_pass")}</label><input id="obPass" type="password" autocomplete="new-password" /></div>
        <div class="ob-field"><label>${T("ob_cedula")} <span class="ob-opt">${T("ob_opcional")}</span></label><input id="obCedula" type="text" inputmode="numeric" autocomplete="off" placeholder="${T("ob_cedula_ph")}" /></div>
        <label class="consent"><input type="checkbox" id="obConsent" />
          <span>${T("consent_1")} <a href="/legal#terminos" target="_blank">${T("consent_terms")}</a> ${T("consent_and")} <a href="/legal#privacidad" target="_blank">${T("consent_privacy")}</a></span></label>
        <p class="ob-err" id="obErr"></p>
        <button class="btn btn-block ob-next" id="obCrear">${T("ob_crear")}</button>
        <p class="ob-switch">${T("m_switch_reg")} <a id="obLogin">${T("m_switch_reg_a")}</a></p>
      </div>`;
    b.querySelector("#obCrear").onclick = crearCuenta;
    b.querySelector("#obLogin").onclick = () => { cerrar(); if (onLogin) onLogin(); };
  }
  async function crearCuenta() {
    const nombre = val("obNombre"), apellido = val("obApellido"), email = val("obEmail"), password = document.getElementById("obPass").value;
    const cedula = val("obCedula");
    const err = document.getElementById("obErr"); err.textContent = "";
    if (!document.getElementById("obConsent").checked) { err.textContent = T("consent_err"); return; }
    const btn = document.getElementById("obCrear"); btn.disabled = true;
    try {
      const r = await api("/auth/registro", { method: "POST", body: { email, password, nombre, apellido, cedula } });
      reconocido = !!(r && r.reconocido);
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
  async function abrirCamara() {
    const video = document.getElementById("obVideo"), avatar = document.getElementById("obAvatar");
    const actions = document.getElementById("obActions");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      video.srcObject = stream; video.hidden = false; avatar.hidden = true;
      actions.innerHTML = `<button class="btn" id="obShoot">${T("ob_capturar")}</button><button class="btn btn-ghost" id="obCancel">✕</button>`;
      actions.querySelector("#obShoot").onclick = capturarSelfie;
      actions.querySelector("#obCancel").onclick = () => { pararCamara(); pFoto(); };
    } catch (e) {
      // Sin permiso/cámara → fallback al input nativo con cámara
      const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*"; inp.capture = "user";
      inp.onchange = (ev) => { const f = ev.target.files[0]; if (f) procesarArchivo(f); };
      inp.click();
    }
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
    try { await api("/perfil/foto", { method: "POST", body: { foto: fotoData } }); } catch (e) {}
  }
  function pararCamara() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }

  // ── Paso 3: ubicación ──
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
        <button class="btn btn-block ob-next" id="obUbicNext">${T("ob_siguiente")}</button>
        <p class="ob-switch"><a id="obUbicSkip">${T("ob_omitir")}</a></p>
      </div>`;
    // prefill país por IP
    api("/geo").then(({ pais }) => { if (pais && pais.iso) { const s = document.getElementById("obPais"); if (s) s.value = pais.iso; } }).catch(() => {});
    b.querySelector("#obUbicNext").onclick = guardarUbic;
    b.querySelector("#obUbicSkip").onclick = () => irPaso(4);
  }
  async function guardarUbic() {
    const pais = document.getElementById("obPais").value, ciudad = val("obCiudad");
    ubicSel = { iso: pais, ciudad };
    try { if (pais || ciudad) await api("/perfil", { method: "PATCH", body: { pais, ciudad } }); } catch (e) {}
    irPaso(4);
  }

  // ── Paso 4: carnet listo ──
  async function pListo() {
    pararCamara();
    const b = document.getElementById("obBody");
    let c = null;
    try { c = (await api("/carnet")).carnet; } catch (e) {}
    const qr = c ? makeQR(location.origin + "/c/" + encodeURIComponent(c.numero)) : "";
    const carnetHtml = c ? carnet({ tierSlug: c.tierSlug, tierNombre: c.tier, nombre: c.nombre, numero: c.numero, foto: c.foto, qr, iso: c.iso }) : "";
    const hayMundo = !!document.getElementById("mundo");
    b.innerHTML = `
      <div class="ob-step ob-listo">
        <h2>${reconocido ? T("ob_socio_h") : T("ob_listo_h")}</h2>
        <p class="ob-sub">${reconocido ? T("ob_socio_p") : T("ob_listo_p")}</p>
        ${carnetHtml}
        <button class="btn btn-block ob-next" id="obIr">${T("ob_ir")}</button>
        ${hayMundo ? `<button class="btn btn-ghost btn-block" id="obMapa" style="margin-top:10px">${T("ob_ver_mapa")}</button>` : ""}
      </div>`;
    b.querySelector(".cn")?.classList.add("cn-reveal");
    setTimeout(() => { try { window.OLI && OLI.confetti && OLI.confetti(); } catch (e) {} }, 250);
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

  function start(opts) { opts = opts || {}; onLogin = opts.onLogin || null; CONFIG = opts.config || CONFIG; fotoData = null; render(); }
  return { start, setConfig: (c) => { CONFIG = c; } };
})();
