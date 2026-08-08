/* onboarding.js — inscripción guiada, mobile-first. 3 pasos visibles (F2 "tres
   pantallas, no cinco"): 1) cuenta  2) país + fecha de nacimiento (define el tier
   por edad — ver routes.js)  3) carnet, con la foto ofrecida ahí mismo (motivo:
   compartirlo), no como paso propio. Ciudad y "bandera exacta" se piden después,
   en Perfil (ya existen ahí) — no duplicar ese trabajo acá.
   La validación de socio con cédula NO vive acá: es una superficie aparte dentro
   de /miembro (ver socio.js).
   Usa OLI (api, carnet, makeQR, fotoModal) y OLI_I18N (t). Llamar OLI_ONB.start(). */
window.OLI_ONB = (function () {
  const { api, carnet, makeQR, fotoModal } = window.OLI;
  const T = (k) => (window.OLI_I18N ? window.OLI_I18N.t(k) : k);
  const LANG = window.OLI_I18N ? window.OLI_I18N.lang() : "es";
  let CONFIG = null, fotoData = null, paso = 1, totalPasos = 3, ubicSel = null;

  function paises() { return (CONFIG && CONFIG.paises) || []; }

  function el(html) { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; }

  function render() {
    const ob = el(`
      <div class="ob" id="onboarding">
        <div class="ob-top">
          <img class="ob-logo" src="/assets/logo-horizontal.svg?v=88" alt="Olimpistas" />
          <button class="ob-close" id="obClose" aria-label="Cerrar">${OLI.icon("x", { size: 18 })}</button>
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
    const ob = document.getElementById("onboarding");
    if (ob) ob.remove();
    document.body.style.overflow = "";
  }
  function pintarDots() {
    const d = document.getElementById("obDots");
    d.innerHTML = Array.from({ length: totalPasos }, (_, i) =>
      `<i class="${i + 1 <= paso ? "on" : ""}"></i>`).join("");
  }
  function irPaso(n) { paso = n; pintarDots(); ({ 1: pCuenta, 2: pPais, 3: pListo }[n])(); }

  // ── Paso 1: cuenta ──
  function pCuenta() {
    const b = document.getElementById("obBody");
    b.innerHTML = `
      <div class="ob-step">
        <h2>${T("ob_cuenta_h")}</h2>
        <p class="ob-sub">${T("ob_cuenta_p")}</p>
        <div class="ob-field"><label>${T("m_nombre")}</label><input id="obNombre" type="text" autocomplete="given-name" /></div>
        <div class="ob-field"><label>${T("m_apellido")}</label><input id="obApellido" type="text" autocomplete="family-name" /></div>
        <div class="ob-field"><label>${T("m_email")}</label><input id="obEmail" type="email" autocomplete="email" /></div>
        <div class="ob-field"><label>${T("m_pass")}</label><div class="pw-wrap"><input id="obPass" type="password" autocomplete="new-password" /><button class="pw-toggle" type="button" aria-label="${T("m_pw_ver")}">${OLI.icon("eye", { size: 18 })}</button></div></div>
        <div class="ob-field"><label>${T("ob_pass2")}</label><div class="pw-wrap"><input id="obPass2" type="password" autocomplete="new-password" /><button class="pw-toggle" type="button" aria-label="${T("m_pw_ver")}">${OLI.icon("eye", { size: 18 })}</button></div></div>
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

  // ── Paso 2: país + fecha de nacimiento. Ciudad y "bandera exacta" quedan para
  // Perfil (ya existen ahí) — este paso solo pide lo que pone al hincha en el mapa
  // mundial y lo que define su nivel por edad. ──
  function pPais() {
    const opts = '<option value="">—</option>' + paises().map((p) => `<option value="${p.iso}">${p.nombre}</option>`).join("");
    const b = document.getElementById("obBody");
    b.innerHTML = `
      <div class="ob-step">
        <h2>${T("ob_ubic_h")}</h2>
        <p class="ob-sub">${T("ob_ubic_p")}</p>
        <div class="ob-field"><label>${T("ob_pais")}</label><select id="obPais">${opts}</select></div>
        <div class="ob-field"><label>${T("ob_fechanac")}</label><input id="obFechaNac" type="date" max="${hoyISO()}" /></div>
        <p class="ob-err" id="obUbicErr"></p>
        <button class="btn btn-block ob-next" id="obUbicNext">${T("ob_ubic_guardar")}</button>
        <p class="ob-switch"><a id="obUbicSkip">${T("ob_omitir_completar")}</a></p>
      </div>`;
    // prefill país por IP
    api("/geo").then(({ pais }) => { if (pais && pais.iso) { const s = document.getElementById("obPais"); if (s) s.value = pais.iso; } }).catch(() => {});
    b.querySelector("#obUbicNext").onclick = guardarPais;
    b.querySelector("#obUbicSkip").onclick = () => irPaso(3);
  }
  function hoyISO() { const d = new Date(); return d.toISOString().slice(0, 10); }
  async function guardarPais() {
    const pais = document.getElementById("obPais").value;
    const fechaNac = document.getElementById("obFechaNac").value;
    const err = document.getElementById("obUbicErr"); if (err) err.textContent = "";
    ubicSel = { iso: pais };
    try {
      const body = {};
      if (pais) body.pais = pais; if (fechaNac) body.fecha_nacimiento = fechaNac;
      if (Object.keys(body).length) await api("/perfil", { method: "PATCH", body });
    } catch (e) { if (err) { err.textContent = e.message; return; } }
    irPaso(3);
  }

  // ── Carnet listo → entra a su cuenta. La foto se ofrece ACÁ (motivo: compartirlo),
  // no como paso propio — mismo criterio que el resto del sitio (ver fotoModal en
  // common.js, usado igual en Perfil). ──
  async function pListo() {
    const b = document.getElementById("obBody");
    let c = null;
    try { c = (await api("/carnet")).carnet; } catch (e) {}
    const qr = c ? makeQR(location.origin + "/c/" + encodeURIComponent(c.numero)) : "";
    const carnetHtml = c ? carnet({ tierSlug: c.tierSlug, tierNombre: c.tier, nombre: c.nombre, numero: c.numero, foto: c.foto || fotoData, qr, iso: c.iso }) : "";
    const hayMundo = !!document.getElementById("mundo");
    b.innerHTML = `
      <div class="ob-step ob-listo">
        <h2>${T("ob_listo_h")}</h2>
        <p class="ob-sub">${T("ob_listo_p")}</p>
        ${carnetHtml}
        ${(c && !c.foto && !fotoData) ? `<p class="ob-switch"><a id="obAgregarFoto">${OLI.icon("camera", { size: 14 })} ${T("ob_agregar_foto")}</a></p>` : ""}
        <p class="ob-ig-cta">${T("ig_cta")}</p>
        <button class="btn btn-block btn-ig" id="obIG">${OLI.icon("camera", { size: 18 })} ${T("ig_compartir")}</button>
        <button class="btn btn-ghost btn-block" id="obIr" style="margin-top:10px">${T("ob_ir")}</button>
        ${hayMundo ? `<button class="btn btn-ghost btn-block" id="obMapa" style="margin-top:10px">${T("ob_ver_mapa")}</button>` : ""}
      </div>`;
    b.querySelector(".cn")?.classList.add("cn-reveal");
    setTimeout(() => { try { window.OLI && OLI.confetti && OLI.confetti(); } catch (e) {} }, 250);
    const agregarFoto = b.querySelector("#obAgregarFoto");
    if (agregarFoto) agregarFoto.onclick = () => fotoModal(async (dataUrl) => {
      fotoData = dataUrl;
      try { await api("/perfil/foto", { method: "POST", body: { foto: dataUrl } }); } catch (e) {}
      pListo(); // re-renderiza con la foto ya puesta
    });
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

  function start(opts) { opts = opts || {}; onLogin = opts.onLogin || null; CONFIG = opts.config || CONFIG; fotoData = null; render(); }
  return { start, setConfig: (c) => { CONFIG = c; } };
})();
