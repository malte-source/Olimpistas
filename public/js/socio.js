/* socio.js — área de socio: perfil + progreso, membresía, contenido, sorteos,
   preventas, carnet. El foco del embudo es completar el perfil. */
(function () {
  const { api, gs, artSvg, toast, yo } = window.OLI;
  let SESSION = null; // { socio, membresia, progreso }
  let CONFIG = null;  // { paises: [{iso,nombre}], ... }
  let perfilPunto = { lat: null, lng: null }; // ubicación exacta elegida
  let perfilGlobo = null;
  const view = () => document.getElementById("view");

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
      try { await api("/pagos/confirmar-simulado", { method: "POST", body: { pedidoId: pago } }); toast("¡Pago confirmado!"); }
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

  // ─── Barra de progreso (persistente) ─────────────────────────────────────────
  function renderProgreso() {
    const p = SESSION.progreso;
    const cont = document.getElementById("progreso");
    if (!p || p.pct >= 100) {
      cont.innerHTML = p && p.pct >= 100
        ? `<div class="progreso"><div class="top"><strong>¡Perfil completo! 🎉</strong><span class="pct">100%</span></div>
           <div class="bar"><i style="width:100%"></i></div></div>` : "";
      return;
    }
    const chips = p.faltantes.map((f) => `<button data-falta="${f.key}">+ ${f.label}</button>`).join("");
    cont.innerHTML = `
      <div class="progreso">
        <div class="top"><strong>Completá tu perfil de Olimpista</strong><span class="pct">${p.pct}%</span></div>
        <div class="bar"><i style="width:${p.pct}%"></i></div>
        <div class="faltantes">${chips}</div>
      </div>`;
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
    const avatar = s.foto
      ? `<img class="avatar" id="avatar" src="${s.foto}" alt="" />`
      : `<div class="avatar" id="avatar">📷</div>`;
    const paises = CONFIG.paises || [];
    const opts = '<option value="">Elegí tu país</option>' +
      paises.map((p) => `<option value="${p.iso}" ${p.iso === s.pais_iso ? "selected" : ""}>${p.nombre}</option>`).join("");
    const tienePunto = perfilPunto.lat != null;
    view().innerHTML = `
      <div class="section" style="border:none;padding-top:8px">
        <h2>Mi perfil</h2>
        <p class="lead">Completá tu perfil y aparecé en el mapa mundial de Olimpistas.</p>
        <div class="perfil">
          <div class="foto-up">
            ${avatar}
            <label for="fotoInput">Cambiar foto</label>
            <input type="file" id="fotoInput" accept="image/*" />
          </div>
          <div>
            <div class="field"><label>Nombre</label><input id="f_nombre" value="${attr(s.nombre)}" placeholder="Tu nombre" /></div>
            <div class="field"><label>WhatsApp</label><input id="f_whatsapp" value="${attr(s.whatsapp)}" placeholder="+595 9xx xxx xxx" /></div>
            <div class="row-2">
              <div class="field"><label>País</label><select id="f_pais">${opts}</select></div>
              <div class="field"><label>Ciudad</label><input id="f_ciudad" value="${attr(s.ciudad)}" placeholder="Tu ciudad" /></div>
            </div>
            <div class="field"><label>Email</label><input value="${attr(s.email)}" disabled /></div>
            <button class="btn" id="guardarPerfil">Guardar cambios</button>
          </div>
        </div>

        <div style="margin-top:30px">
          <h3 style="margin:0 0 4px">Tu punto en el mapa</h3>
          <p class="lead" style="margin-bottom:12px">Fijá tu ubicación exacta y tu bandera aparece en el globo mundial.</p>
          <div class="ubic">
            <button class="btn btn-ghost" id="btnGeo" type="button">📍 Usar mi ubicación actual</button>
            <span id="ubicEstado" class="muted">${tienePunto ? "Punto fijado ✓" : "Sin fijar"}</span>
          </div>
          <div id="perfilGlobo" class="perfil-globo"></div>
          <p class="muted" style="font-size:12px;text-align:center">Tocá el globo para fijar tu punto, o usá tu ubicación actual.</p>
        </div>
      </div>`;
    document.getElementById("guardarPerfil").onclick = guardarPerfil;
    document.getElementById("fotoInput").onchange = subirFoto;
    document.getElementById("btnGeo").onclick = usarUbicacion;
    // Prefill de país por IP si todavía no tiene uno.
    if (!s.pais_iso) prefillPaisPorIP();
    initPerfilGlobo();
  }

  async function prefillPaisPorIP() {
    try {
      const { pais } = await api("/geo");
      if (pais && pais.iso) {
        const sel = document.getElementById("f_pais");
        if (sel && !sel.value) sel.value = pais.iso;
        if (perfilPunto.lat == null && pais.lat != null) {
          perfilPunto = { lat: pais.lat, lng: pais.lng };
          pintarPunto();
        }
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
  function marcarFijado() {
    const e = document.getElementById("ubicEstado");
    if (e) e.textContent = "Punto fijado ✓";
  }

  function usarUbicacion() {
    if (!navigator.geolocation) return toast("Tu navegador no permite geolocalización");
    const e = document.getElementById("ubicEstado");
    if (e) e.textContent = "Buscando tu ubicación…";
    navigator.geolocation.getCurrentPosition(
      (pos) => { perfilPunto = { lat: pos.coords.latitude, lng: pos.coords.longitude }; pintarPunto(); marcarFijado(); },
      () => { if (e) e.textContent = "No se pudo obtener (permiso denegado)"; },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  async function guardarPerfil() {
    const body = {
      nombre: val("f_nombre"), whatsapp: val("f_whatsapp"),
      pais: document.getElementById("f_pais").value, ciudad: val("f_ciudad"),
    };
    if (perfilPunto.lat != null) { body.lat = perfilPunto.lat; body.lng = perfilPunto.lng; }
    try {
      const r = await api("/perfil", { method: "PATCH", body });
      SESSION.socio = r.socio; SESSION.progreso = r.progreso;
      document.getElementById("hola").textContent = r.socio.nombre || r.socio.email;
      renderProgreso(); toast("Perfil actualizado ✓");
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
      renderProgreso(); toast("Foto actualizada ✓");
    } catch (err) { toast(err.message); }
  }

  // Redimensiona/recorta a un cuadrado y devuelve un data URL JPEG liviano.
  function redimensionar(file, size) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const ctx = c.getContext("2d");
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2, sy = (img.height - min) / 2;
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
    view().innerHTML = '<p class="muted">Cargando…</p>';
    const { membresia, tier } = await api("/membresia");
    const { tiers } = await api("/config");
    const pagos = tiers.filter((t) => t.nivel > 0);
    const esGratis = !membresia || tier?.nivel === 0;
    const upsell = esGratis ? `
      <h3 style="margin-top:28px">Subí de nivel</h3>
      <div class="grid-3">${pagos.map(cardUpsell).join("")}</div>` : "";
    view().innerHTML = `
      <div class="section" style="border:none;padding-top:8px">
        <h2>Sos ${tier ? tier.nombre : "Olimpista"} <span style="color:var(--oro)">●</span></h2>
        <p class="lead">Miembro desde ${membresia ? new Date(membresia.inicio).toLocaleDateString("es-PY") : "hoy"}.</p>
        <ul class="benefits" style="max-width:520px">${(tier?.beneficios || []).map((b) => `<li>${b}</li>`).join("")}</ul>
        ${upsell}
      </div>`;
    view().querySelectorAll("[data-upsell]").forEach((b) => b.addEventListener("click", () => upgrade(b.dataset.upsell)));
  }
  function cardUpsell(t) {
    const precio = t.precioAnio > 0 ? `${gs(t.precioAnio)} / año` : "Gratis";
    return `
      <div class="card"><div class="thumb">${artSvg(t.slug, t.nombre, t.slug === "premium" ? "♛" : "🎈")}</div>
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

  // ─── Olimpia Media+ ──────────────────────────────────────────────────────────────
  async function vContenido() {
    view().innerHTML = '<p class="muted">Cargando…</p>';
    const { items } = await api("/contenido");
    view().innerHTML = `
      <div class="section" style="border:none;padding-top:8px">
        <h2>Olimpia Media+</h2><p class="lead">Contenido exclusivo para Olimpistas.</p>
        <div class="grid-3">${items.map(cardContenido).join("")}</div>
      </div>`;
    view().querySelectorAll("[data-play]").forEach((el) => el.addEventListener("click", () => reproducir(el.dataset.play)));
  }
  function cardContenido(c) {
    const lock = c.desbloqueado ? "" : `<div class="lock"><span>🔒 Premium</span></div>`;
    return `
      <div class="card"><div class="thumb">${artSvg(c.id, c.titulo, "▶")}${lock}</div>
        <div class="body"><span class="chip ${c.desbloqueado ? "on" : ""}">${c.tipo} · ${c.duracion || ""}</span>
        <h4>${c.titulo}</h4><p>${c.descripcion}</p>
        <button class="btn ${c.desbloqueado ? "" : "btn-ghost"}" ${c.desbloqueado ? `data-play="${c.id}"` : "disabled"}>
          ${c.desbloqueado ? "Reproducir" : "Solo Premium"}</button></div></div>`;
  }
  async function reproducir(id) {
    try { const r = await api("/contenido/" + id); toast("▶ " + r.item.titulo + " (demo)"); }
    catch (e) { toast(e.message); }
  }

  // ─── Sorteos ───────────────────────────────────────────────────────────────────
  async function vSorteos() {
    view().innerHTML = '<p class="muted">Cargando…</p>';
    const { items } = await api("/sorteos");
    view().innerHTML = `
      <div class="section" style="border:none;padding-top:8px">
        <h2>Sorteos</h2><p class="lead">Participá por premios exclusivos del Decano.</p>
        <div class="grid-3">${items.map(cardSorteo).join("")}</div>
      </div>`;
    view().querySelectorAll("[data-sorteo]").forEach((el) => el.addEventListener("click", () => participar(el.dataset.sorteo)));
  }
  function cardSorteo(s) {
    let btn;
    if (s.participando) btn = `<button class="btn btn-ghost" disabled>✓ Ya participás</button>`;
    else if (!s.elegible) btn = `<button class="btn btn-ghost" disabled>Solo Premium</button>`;
    else btn = `<button class="btn" data-sorteo="${s.id}">Participar</button>`;
    return `
      <div class="card"><div class="thumb">${artSvg(s.id, s.titulo, "🎁")}</div>
        <div class="body"><span class="chip ${s.elegible ? "on" : ""}">Cierra ${s.cierra}</span>
        <h4>${s.titulo}</h4><p>${s.descripcion}</p>${btn}</div></div>`;
  }
  async function participar(id) {
    try { await api("/sorteos/" + id + "/participar", { method: "POST" }); toast("¡Estás participando! 🍀"); vSorteos(); }
    catch (e) { toast(e.message); }
  }

  // ─── Preventas ─────────────────────────────────────────────────────────────────
  async function vPreventas() {
    view().innerHTML = '<p class="muted">Cargando…</p>';
    const { items } = await api("/preventas");
    view().innerHTML = `
      <div class="section" style="border:none;padding-top:8px">
        <h2>Preventa de entradas</h2><p class="lead">Comprá antes que nadie.</p>
        <div class="grid-3">${items.map(cardPreventa).join("")}</div>
      </div>`;
    view().querySelectorAll("[data-preventa]").forEach((el) => el.addEventListener("click", () => reservar(el.dataset.preventa)));
  }
  function cardPreventa(p) {
    const btn = p.habilitada
      ? `<button class="btn" data-preventa="${p.id}">Reservar (${gs(p.precio_desde)})</button>`
      : `<button class="btn btn-ghost" disabled>Solo Premium</button>`;
    return `
      <div class="card"><div class="thumb">${artSvg(p.id, p.evento, "🎟")}</div>
        <div class="body"><span class="chip ${p.habilitada ? "on" : ""}">${p.fecha} · ${p.sede}</span>
        <h4>${p.evento}</h4><p>Desde ${gs(p.precio_desde)} · ${p.stock} en preventa</p>${btn}</div></div>`;
  }
  async function reservar(id) {
    try { await api("/preventas/" + id + "/reservar", { method: "POST", body: { cantidad: 1 } }); toast("Reserva confirmada ✓"); vPreventas(); }
    catch (e) { toast(e.message); }
  }

  // ─── Carnet digital premium (con QR escaneable) ──────────────────────────────
  async function vCarnet() {
    view().innerHTML = '<p class="muted">Cargando…</p>';
    try {
      const { carnet } = await api("/carnet");
      const verifyUrl = location.origin + "/c/" + encodeURIComponent(carnet.numero);
      const qrSrc = makeQR(verifyUrl);
      const inicial = (carnet.nombre || "O").trim()[0].toUpperCase();
      const foto = carnet.foto
        ? `<img class="cn-foto" src="${carnet.foto}" alt="" />`
        : `<div class="cn-foto cn-foto-ph">${inicial}</div>`;
      const desde = new Date(carnet.desde).toLocaleDateString("es-PY");
      view().innerHTML = `
        <div class="section" style="border:none;padding-top:8px">
          <h2>Mi carnet digital</h2>
          <p class="lead">Mostralo en el estadio y en la tienda oficial.</p>
          <div class="cn-wrap">
            <div class="cn-card">
              <div class="cn-head">
                <img src="/assets/logo-horizontal.svg" alt="Olimpistas" class="cn-logo" />
              </div>
              ${foto}
              <div class="cn-body">
                <div class="cn-nom">${carnet.nombre}</div>
                <div class="cn-badge">Nivel · ${carnet.tier}</div>
                <div class="cn-qr">${qrSrc ? `<img src="${qrSrc}" alt="QR de miembro" />` : '<p class="muted">QR no disponible</p>'}</div>
                <div class="cn-num">${carnet.numero}</div>
                <div class="cn-foot">Olimpista desde ${desde}</div>
              </div>
            </div>
          </div>
        </div>`;
    } catch (e) {
      view().innerHTML = `<div class="section" style="border:none"><h2>Carnet no disponible</h2><p class="lead">${e.message}</p></div>`;
    }
  }

  // Genera un QR (data URL) con el generador vendorizado.
  function makeQR(text) {
    try {
      const qr = window.qrcode(0, "M");
      qr.addData(text); qr.make();
      return qr.createDataURL(6, 2);
    } catch (e) { return ""; }
  }

  const val = (id) => (document.getElementById(id)?.value || "").trim();
  const attr = (s) => String(s || "").replace(/"/g, "&quot;");

  init().catch((e) => { view().innerHTML = '<p class="error">' + e.message + "</p>"; });
})();
