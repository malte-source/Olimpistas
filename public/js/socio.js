/* socio.js — área de socio: perfil + progreso, membresía, contenido, sorteos,
   preventas, carnet. Bilingüe (OLI_I18N) + UX premium (skeletons, transiciones,
   anillo de progreso). El foco del embudo es completar el perfil. */
(function () {
  const { api, gs, artSvg, toast, yo, carnet: carnetHTML, makeQR } = window.OLI;
  const T = (k) => (window.OLI_I18N ? window.OLI_I18N.t(k) : k);
  const LANG = window.OLI_I18N ? window.OLI_I18N.lang() : "es";
  const LOC = LANG === "en" ? "en-US" : "es-PY";
  let SESSION = null; // { socio, membresia, progreso }
  let CONFIG = null;  // { paises: [{iso,nombre}], ... }
  let perfilPunto = { lat: null, lng: null }; // ubicación exacta elegida
  let perfilGlobo = null;
  const view = () => document.getElementById("view");
  const fecha = (d) => new Date(d).toLocaleDateString(LOC, { year: "numeric", month: "long", day: "numeric" });

  // Skeleton de carga (en vez de "Cargando…").
  function skeleton(cards) {
    const c = cards == null ? 3 : cards;
    return `<div class="section" style="border:none;padding-top:8px">
      <div class="sk sk-h"></div><div class="sk sk-line"></div>
      ${c ? `<div class="grid-3">${'<div class="sk sk-card"></div>'.repeat(c)}</div>` : ""}</div>`;
  }

  async function init() {
    SESSION = await yo();
    if (!SESSION) { location.href = "/"; return; }
    CONFIG = await api("/config").catch(() => ({ paises: [] }));
    perfilPunto = { lat: SESSION.socio.lat ?? null, lng: SESSION.socio.lng ?? null };
    document.getElementById("hola").textContent = SESSION.socio.nombre || SESSION.socio.email;
    document.getElementById("logoutBtn").onclick = logout;
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => activar(t.dataset.tab)));

    const pago = new URLSearchParams(location.search).get("pago_simulado");
    if (pago) {
      try { await api("/pagos/confirmar-simulado", { method: "POST", body: { pedidoId: pago } }); toast(T("m_pago_ok")); }
      catch (e) { toast(e.message); }
      history.replaceState({}, "", "/miembro");
      SESSION = await yo();
    }
    renderProgreso();
    activar("perfil");
  }

  function activar(tab) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    ({ perfil: vPerfil, membresia: vMembresia, contenido: vContenido, sorteos: vSorteos, preventas: vPreventas, carnet: vCarnet }[tab])();
  }

  async function logout() { try { await api("/auth/logout", { method: "POST" }); } finally { location.href = "/"; } }
  async function refrescar() { SESSION = await yo(); renderProgreso(); }

  // ─── Anillo de progreso (persistente, animado) ───────────────────────────────
  function renderProgreso() {
    const p = SESSION.progreso;
    const cont = document.getElementById("progreso");
    if (!p) { cont.innerHTML = ""; return; }
    const completo = p.pct >= 100;
    const chips = completo ? "" : (p.faltantes || []).map((f) => `<button data-falta="${f.key}">+ ${f.label}</button>`).join("");
    const C = 175.9; // 2π·28
    cont.innerHTML = `
      <div class="progreso">
        <div class="prog-ring">
          <svg viewBox="0 0 64 64"><circle class="rb" cx="32" cy="32" r="28"/><circle class="rf" cx="32" cy="32" r="28" style="stroke-dasharray:${C};stroke-dashoffset:${C}"/></svg>
          <span class="prog-pct">${p.pct}%</span>
        </div>
        <div class="prog-info">
          <strong>${completo ? T("m_prog_done") : T("m_prog_h")}</strong>
          ${chips ? `<div class="faltantes">${chips}</div>` : ""}
        </div>
      </div>`;
    const rf = cont.querySelector(".rf");
    if (rf) requestAnimationFrame(() => { rf.style.strokeDashoffset = String(C * (1 - p.pct / 100)); });
    cont.querySelectorAll("[data-falta]").forEach((b) =>
      b.addEventListener("click", () => { activar("perfil"); setTimeout(() => focusCampo(b.dataset.falta), 60); })
    );
  }
  function focusCampo(key) {
    const el = document.getElementById("f_" + key) || (key === "foto" && document.getElementById("fotoInput"));
    if (el) { el.focus?.(); el.scrollIntoView({ behavior: "smooth", block: "center" }); }
  }

  // ─── Mi perfil ───────────────────────────────────────────────────────────────
  function vPerfil() {
    const s = SESSION.socio;
    const avatar = s.foto ? `<img class="avatar" id="avatar" src="${s.foto}" alt="" />` : `<div class="avatar" id="avatar">📷</div>`;
    const paises = CONFIG.paises || [];
    const opts = `<option value="">${T("m_elegi_pais")}</option>` +
      paises.map((p) => `<option value="${p.iso}" ${p.iso === s.pais_iso ? "selected" : ""}>${p.nombre}</option>`).join("");
    const tienePunto = perfilPunto.lat != null;
    view().innerHTML = `
      <div class="section" style="border:none;padding-top:8px">
        <h2>${T("m_perfil_h")}</h2>
        <p class="lead">${T("m_perfil_p")}</p>
        <div class="perfil">
          <div class="foto-up">
            ${avatar}
            <label for="fotoInput">${T("m_foto_cambiar")}</label>
            <input type="file" id="fotoInput" accept="image/*" />
          </div>
          <div>
            <div class="row-2">
              <div class="field"><label>${T("m_nombre")}</label><input id="f_nombre" value="${attr(s.nombre)}" /></div>
              <div class="field"><label>${T("m_apellido")}</label><input id="f_apellido" value="${attr(s.apellido)}" /></div>
            </div>
            <div class="field"><label>${T("m_whatsapp")}</label><input id="f_whatsapp" value="${attr(s.whatsapp)}" placeholder="+595 9xx xxx xxx" /></div>
            <div class="row-2">
              <div class="field"><label>${T("m_pais")}</label><select id="f_pais">${opts}</select></div>
              <div class="field"><label>${T("m_ciudad")}</label><input id="f_ciudad" value="${attr(s.ciudad)}" /></div>
            </div>
            <div class="field"><label>${T("m_email")}</label><input value="${attr(s.email)}" disabled /></div>
            <button class="btn" id="guardarPerfil">${T("m_guardar")}</button>
          </div>
        </div>

        <div style="margin-top:30px">
          <h3 style="margin:0 0 4px">${T("m_casa_h")}</h3>
          <p class="lead" style="margin-bottom:12px">${T("m_casa_p")}</p>
          <div class="ubic">
            <button class="btn btn-ghost" id="btnGeo" type="button">${T("m_geo")}</button>
            <span id="ubicEstado" class="muted">${tienePunto ? T("m_fijado") : T("m_sin_fijar")}</span>
          </div>
          <div id="perfilGlobo" class="perfil-globo"></div>
          <p class="muted" style="font-size:12px;text-align:center">${T("m_casa_toca")}</p>
          <label class="casa-toggle" for="f_exacto">
            <input type="checkbox" id="f_exacto" ${s.mostrar_exacto ? "checked" : ""} />
            <span><strong>${T("m_exacto_h")}</strong><br><small class="muted">${T("m_exacto_p")}</small></span>
          </label>
        </div>
      </div>`;
    document.getElementById("guardarPerfil").onclick = guardarPerfil;
    document.getElementById("fotoInput").onchange = subirFoto;
    document.getElementById("btnGeo").onclick = usarUbicacion;
    if (!s.pais_iso) prefillPaisPorIP();
    initPerfilGlobo();
  }

  async function prefillPaisPorIP() {
    try {
      const { pais } = await api("/geo");
      if (pais && pais.iso) {
        const sel = document.getElementById("f_pais");
        if (sel && !sel.value) sel.value = pais.iso;
        if (perfilPunto.lat == null && pais.lat != null) { perfilPunto = { lat: pais.lat, lng: pais.lng }; pintarPunto(); }
      }
    } catch { /* sin geo */ }
  }

  function initPerfilGlobo() {
    const el = document.getElementById("perfilGlobo");
    let n = 0;
    const t = setInterval(() => {
      if (window.OLI_GLOBE && window.maplibregl) {
        clearInterval(t);
        perfilGlobo = window.OLI_GLOBE.create(el, {
          autoRotate: false, maxH: 300,
          onPick: (lat, lng) => { perfilPunto = { lat, lng }; pintarPunto(); marcarFijado(); },
        });
        pintarPunto();
      } else if (++n > 60) clearInterval(t);
    }, 100);
  }
  function pintarPunto() {
    if (!perfilGlobo) return;
    if (perfilPunto.lat == null) { perfilGlobo.setData([]); return; }
    perfilGlobo.setData([{ lat: perfilPunto.lat, lng: perfilPunto.lng, ciudad: "Tu punto", pais: "", count: 1 }]);
    perfilGlobo.pov({ lat: perfilPunto.lat, lng: perfilPunto.lng, zoom: 5 });
  }
  function marcarFijado() { const e = document.getElementById("ubicEstado"); if (e) e.textContent = T("m_fijado"); }

  function usarUbicacion() {
    if (!navigator.geolocation) return toast(T("m_geo_no"));
    const e = document.getElementById("ubicEstado");
    if (e) e.textContent = T("m_buscando");
    navigator.geolocation.getCurrentPosition(
      (pos) => { perfilPunto = { lat: pos.coords.latitude, lng: pos.coords.longitude }; pintarPunto(); marcarFijado(); },
      () => { if (e) e.textContent = T("m_geo_err"); },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  async function guardarPerfil() {
    const body = { nombre: val("f_nombre"), apellido: val("f_apellido"), whatsapp: val("f_whatsapp"), pais: document.getElementById("f_pais").value, ciudad: val("f_ciudad") };
    if (perfilPunto.lat != null) { body.lat = perfilPunto.lat; body.lng = perfilPunto.lng; }
    const exacto = document.getElementById("f_exacto");
    if (exacto) body.mostrar_exacto = exacto.checked;
    try {
      const r = await api("/perfil", { method: "PATCH", body });
      SESSION.socio = r.socio; SESSION.progreso = r.progreso;
      document.getElementById("hola").textContent = r.socio.nombre || r.socio.email;
      renderProgreso();
      toast(body.mostrar_exacto && perfilPunto.lat != null ? T("m_casa_ok") : T("m_perfil_ok"));
    } catch (e) { toast(e.message); }
  }

  async function subirFoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await redimensionar(file, 256);
      const r = await api("/perfil/foto", { method: "POST", body: { foto: dataUrl } });
      SESSION.socio.foto = r.foto; SESSION.progreso = r.progreso;
      document.getElementById("avatar").outerHTML = `<img class="avatar" id="avatar" src="${r.foto}" alt="" />`;
      renderProgreso(); toast(T("m_foto_ok"));
    } catch (err) { toast(err.message); }
  }

  function redimensionar(file, size) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas"); c.width = c.height = size;
        const ctx = c.getContext("2d");
        const min = Math.min(img.width, img.height), sx = (img.width - min) / 2, sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("No se pudo leer la imagen"));
      const fr = new FileReader();
      fr.onload = () => (img.src = fr.result);
      fr.onerror = () => reject(new Error("No se pudo leer el archivo"));
      fr.readAsDataURL(file);
    });
  }

  // ─── Mi membresía ────────────────────────────────────────────────────────────
  async function vMembresia() {
    view().innerHTML = skeleton(3);
    const { membresia, tier } = await api("/membresia");
    const { tiers } = await api("/config");
    const pagos = tiers.filter((t) => t.nivel > 0);
    const esGratis = !membresia || tier?.nivel === 0;
    const social = await socialPais();
    const upsell = esGratis ? `<h3 style="margin-top:28px">${T("m_subi")}</h3><div class="grid-3">${pagos.map(cardUpsell).join("")}</div>` : "";
    view().innerHTML = `
      <div class="section" style="border:none;padding-top:8px">
        <h2>${T("m_sos")} ${tier ? tier.nombre : "Olimpista"} <span style="color:var(--oro)">●</span></h2>
        <p class="lead">${T("m_miembro_desde")} ${membresia ? fecha(membresia.inicio) : "—"}.</p>
        ${social}
        <ul class="benefits" style="max-width:520px">${(tier?.beneficios || []).map((b) => `<li>${b}</li>`).join("")}</ul>
        ${upsell}
      </div>`;
    view().querySelectorAll("[data-upsell]").forEach((b) => b.addEventListener("click", () => upgrade(b.dataset.upsell)));
  }
  // "Sos uno de X Olimpistas en [tu país]" — prueba social personalizada.
  async function socialPais() {
    try {
      const iso = SESSION.socio.pais_iso; if (!iso) return "";
      const { porPais } = await api("/stats");
      const p = (porPais || []).find((x) => x.iso === iso); if (!p) return "";
      return `<p class="social-pais">🌎 ${T("m_social_pre")} <strong>${Number(p.count).toLocaleString(LOC)}</strong> ${T("m_social_in")} ${p.nombre}</p>`;
    } catch { return ""; }
  }
  function cardUpsell(t) {
    const precio = t.precioAnio > 0 ? `${gs(t.precioAnio)} / ${T("m_anio")}` : T("price_gratis");
    return `<div class="card"><div class="thumb">${artSvg(t.slug, t.nombre, t.slug === "premium" ? "♛" : "🎈")}</div>
      <div class="body"><span class="chip on">${precio}</span><h4>${t.nombre}</h4>
      <p>${t.beneficios.slice(1, 3).join(" · ")}</p>
      <button class="btn" data-upsell="${t.slug}">${t.cta}</button></div></div>`;
  }
  async function upgrade(slug) {
    try {
      const r = await api("/membresia/unirse", { method: "POST", body: { tier: slug } });
      if (r.gratis) { await refrescar(); return vMembresia(); }
      location.href = r.pago.urlPago;
    } catch (e) { toast(e.message); }
  }

  // ─── Olimpia Media+ ──────────────────────────────────────────────────────────
  async function vContenido() {
    view().innerHTML = skeleton(3);
    const { items } = await api("/contenido");
    view().innerHTML = `<div class="section" style="border:none;padding-top:8px">
      <h2>${T("m_media_h")}</h2><p class="lead">${T("m_media_p")}</p>
      <div class="grid-3">${items.map(cardContenido).join("")}</div></div>`;
    view().querySelectorAll("[data-play]").forEach((el) => el.addEventListener("click", () => reproducir(el.dataset.play)));
  }
  function cardContenido(c) {
    const lock = c.desbloqueado ? "" : `<div class="lock"><span>🔒 Premium</span></div>`;
    return `<div class="card"><div class="thumb">${artSvg(c.id, c.titulo, "▶")}${lock}</div>
      <div class="body"><span class="chip ${c.desbloqueado ? "on" : ""}">${c.tipo} · ${c.duracion || ""}</span>
      <h4>${c.titulo}</h4><p>${c.descripcion}</p>
      <button class="btn ${c.desbloqueado ? "" : "btn-ghost"}" ${c.desbloqueado ? `data-play="${c.id}"` : "disabled"}>
        ${c.desbloqueado ? T("m_reproducir") : T("m_solo_premium")}</button></div></div>`;
  }
  async function reproducir(id) {
    try { const r = await api("/contenido/" + id); toast("▶ " + r.item.titulo + " " + T("m_demo")); }
    catch (e) { toast(e.message); }
  }

  // ─── Sorteos ───────────────────────────────────────────────────────────────────
  async function vSorteos() {
    view().innerHTML = skeleton(3);
    const { items } = await api("/sorteos");
    view().innerHTML = `<div class="section" style="border:none;padding-top:8px">
      <h2>${T("m_sorteos_h")}</h2><p class="lead">${T("m_sorteos_p")}</p>
      <div class="grid-3">${items.map(cardSorteo).join("")}</div></div>`;
    view().querySelectorAll("[data-sorteo]").forEach((el) => el.addEventListener("click", () => participar(el.dataset.sorteo)));
  }
  function cardSorteo(s) {
    let btn;
    if (s.participando) btn = `<button class="btn btn-ghost" disabled>${T("m_ya_participas")}</button>`;
    else if (!s.elegible) btn = `<button class="btn btn-ghost" disabled>${T("m_solo_premium")}</button>`;
    else btn = `<button class="btn" data-sorteo="${s.id}">${T("m_participar")}</button>`;
    return `<div class="card"><div class="thumb">${artSvg(s.id, s.titulo, "🎁")}</div>
      <div class="body"><span class="chip ${s.elegible ? "on" : ""}">${T("m_cierra")} ${s.cierra}</span>
      <h4>${s.titulo}</h4><p>${s.descripcion}</p>${btn}</div></div>`;
  }
  async function participar(id) {
    try { await api("/sorteos/" + id + "/participar", { method: "POST" }); toast(T("m_participando")); vSorteos(); }
    catch (e) { toast(e.message); }
  }

  // ─── Preventas ─────────────────────────────────────────────────────────────────
  async function vPreventas() {
    view().innerHTML = skeleton(3);
    const { items } = await api("/preventas");
    view().innerHTML = `<div class="section" style="border:none;padding-top:8px">
      <h2>${T("m_preventas_h")}</h2><p class="lead">${T("m_preventas_p")}</p>
      <div class="grid-3">${items.map(cardPreventa).join("")}</div></div>`;
    view().querySelectorAll("[data-preventa]").forEach((el) => el.addEventListener("click", () => reservar(el.dataset.preventa)));
  }
  function cardPreventa(p) {
    const btn = p.habilitada
      ? `<button class="btn" data-preventa="${p.id}">${T("m_reservar")} (${gs(p.precio_desde)})</button>`
      : `<button class="btn btn-ghost" disabled>${T("m_solo_premium")}</button>`;
    return `<div class="card"><div class="thumb">${artSvg(p.id, p.evento, "🎟")}</div>
      <div class="body"><span class="chip ${p.habilitada ? "on" : ""}">${p.fecha} · ${p.sede}</span>
      <h4>${p.evento}</h4><p>${T("m_desde")} ${gs(p.precio_desde)} · ${p.stock} ${T("m_en_preventa")}</p>${btn}</div></div>`;
  }
  async function reservar(id) {
    try { await api("/preventas/" + id + "/reservar", { method: "POST", body: { cantidad: 1 } }); toast(T("m_reserva_ok")); vPreventas(); }
    catch (e) { toast(e.message); }
  }

  // ─── Carnet digital (mismo componente que la landing, color por nivel) ───────
  async function vCarnet() {
    view().innerHTML = skeleton(0);
    try {
      const { carnet } = await api("/carnet");
      const qr = makeQR(location.origin + "/c/" + encodeURIComponent(carnet.numero));
      view().innerHTML = `
        <div class="section" style="border:none;padding-top:8px">
          <h2>${T("m_carnet_h")}</h2>
          <p class="lead">${T("m_carnet_p")}</p>
          <div class="cn-wrap">
            ${carnetHTML({ tierSlug: carnet.tierSlug, tierNombre: carnet.tier, nombre: carnet.nombre, numero: carnet.numero, foto: carnet.foto, qr })}
          </div>
          <p class="muted" style="text-align:center;margin-top:14px">${T("m_miembro_desde")} ${fecha(carnet.desde)}</p>
        </div>`;
    } catch (e) {
      view().innerHTML = `<div class="section" style="border:none"><h2>${T("m_carnet_no")}</h2><p class="lead">${e.message}</p></div>`;
    }
  }

  const val = (id) => (document.getElementById(id)?.value || "").trim();
  const attr = (s) => String(s || "").replace(/"/g, "&quot;");

  init().catch((e) => { view().innerHTML = '<p class="error">' + e.message + "</p>"; });
})();
