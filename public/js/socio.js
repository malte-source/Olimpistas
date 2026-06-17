/* socio.js — área de socio: membresía, contenido, sorteos, preventas, carnet. */
(function () {
  const { api, gs, artSvg, toast, yo } = window.OLI;
  let SESSION = null;
  const view = () => document.getElementById("view");

  async function init() {
    SESSION = await yo();
    if (!SESSION) { location.href = "/"; return; }
    document.getElementById("hola").textContent = SESSION.socio.nombre || SESSION.socio.email;
    document.getElementById("logoutBtn").onclick = logout;
    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => activar(t.dataset.tab))
    );
    // ¿Volvió de un pago simulado a /socio?
    const pago = new URLSearchParams(location.search).get("pago_simulado");
    if (pago) {
      try { await api("/pagos/confirmar-simulado", { method: "POST", body: { pedidoId: pago } }); toast("¡Pago confirmado!"); }
      catch (e) { toast(e.message); }
      history.replaceState({}, "", "/socio");
    }
    activar("membresia");
  }

  function activar(tab) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    ({ membresia: vMembresia, contenido: vContenido, sorteos: vSorteos, preventas: vPreventas, carnet: vCarnet }[tab])();
  }

  async function logout() { try { await api("/auth/logout", { method: "POST" }); } finally { location.href = "/"; } }

  // ─── Membresía ─────────────────────────────────────────────────────────────
  async function vMembresia() {
    view().innerHTML = '<p class="muted">Cargando…</p>';
    const { membresia, tier } = await api("/membresia");
    if (!membresia) {
      view().innerHTML = `
        <div class="section" style="border:none;padding-top:8px">
          <h2>Todavía no tenés un plan activo</h2>
          <p class="lead">Elegí tu nivel de Olimpista para desbloquear contenido, preventas y sorteos.</p>
          <a class="btn" href="/">Ver planes</a>
        </div>`;
      return;
    }
    view().innerHTML = `
      <div class="section" style="border:none;padding-top:8px">
        <h2>Sos ${tier.nombre} <span style="color:var(--oro)">●</span></h2>
        <p class="lead">Membresía activa desde ${new Date(membresia.inicio).toLocaleDateString("es-PY")} · ciclo ${membresia.ciclo}.</p>
        <ul class="benefits" style="max-width:520px">${tier.beneficios.map((b) => `<li>${b}</li>`).join("")}</ul>
        <div style="margin-top:24px"><a class="btn btn-ghost" href="/">Cambiar de plan</a></div>
      </div>`;
  }

  // ─── Contenido (Olimpia Play) ────────────────────────────────────────────────
  async function vContenido() {
    view().innerHTML = '<p class="muted">Cargando…</p>';
    const { items } = await api("/contenido");
    view().innerHTML = `
      <div class="section" style="border:none;padding-top:8px">
        <h2>Olimpia Play</h2>
        <p class="lead">Contenido exclusivo para Olimpistas.</p>
        <div class="grid-3">${items.map(cardContenido).join("")}</div>
      </div>`;
    view().querySelectorAll("[data-play]").forEach((el) =>
      el.addEventListener("click", () => reproducir(el.dataset.play))
    );
  }
  function cardContenido(c) {
    const lock = c.desbloqueado ? "" :
      `<div class="lock"><span>🔒 Nivel ${c.tier_min}+</span></div>`;
    return `
      <div class="card">
        <div class="thumb">${artSvg(c.id, c.titulo, "▶")}${lock}</div>
        <div class="body">
          <span class="chip ${c.desbloqueado ? "on" : ""}">${c.tipo} · ${c.duracion || ""}</span>
          <h4>${c.titulo}</h4>
          <p>${c.descripcion}</p>
          <button class="btn ${c.desbloqueado ? "" : "btn-ghost"}" ${c.desbloqueado ? `data-play="${c.id}"` : "disabled"}>
            ${c.desbloqueado ? "Reproducir" : "Requiere nivel superior"}
          </button>
        </div>
      </div>`;
  }
  async function reproducir(id) {
    try { const r = await api("/contenido/" + id); toast("▶ " + r.item.titulo + " (demo)"); }
    catch (e) { toast(e.message); }
  }

  // ─── Sorteos ───────────────────────────────────────────────────────────────
  async function vSorteos() {
    view().innerHTML = '<p class="muted">Cargando…</p>';
    const { items } = await api("/sorteos");
    view().innerHTML = `
      <div class="section" style="border:none;padding-top:8px">
        <h2>Sorteos</h2>
        <p class="lead">Participá por premios exclusivos del Decano.</p>
        <div class="grid-3">${items.map(cardSorteo).join("")}</div>
      </div>`;
    view().querySelectorAll("[data-sorteo]").forEach((el) =>
      el.addEventListener("click", () => participar(el.dataset.sorteo))
    );
  }
  function cardSorteo(s) {
    let btn;
    if (s.participando) btn = `<button class="btn btn-ghost" disabled>✓ Ya participás</button>`;
    else if (!s.elegible) btn = `<button class="btn btn-ghost" disabled>Requiere nivel ${s.tier_min}+</button>`;
    else btn = `<button class="btn" data-sorteo="${s.id}">Participar</button>`;
    return `
      <div class="card">
        <div class="thumb">${artSvg(s.id, s.titulo, "🎁")}</div>
        <div class="body">
          <span class="chip ${s.elegible ? "on" : ""}">Cierra ${s.cierra}</span>
          <h4>${s.titulo}</h4><p>${s.descripcion}</p>${btn}
        </div>
      </div>`;
  }
  async function participar(id) {
    try { await api("/sorteos/" + id + "/participar", { method: "POST" }); toast("¡Estás participando! 🍀"); vSorteos(); }
    catch (e) { toast(e.message); }
  }

  // ─── Preventas ───────────────────────────────────────────────────────────────
  async function vPreventas() {
    view().innerHTML = '<p class="muted">Cargando…</p>';
    const { items } = await api("/preventas");
    view().innerHTML = `
      <div class="section" style="border:none;padding-top:8px">
        <h2>Preventa de entradas</h2>
        <p class="lead">Comprá antes que nadie. Acceso prioritario según tu nivel.</p>
        <div class="grid-3">${items.map(cardPreventa).join("")}</div>
      </div>`;
    view().querySelectorAll("[data-preventa]").forEach((el) =>
      el.addEventListener("click", () => reservar(el.dataset.preventa))
    );
  }
  function cardPreventa(p) {
    const btn = p.habilitada
      ? `<button class="btn" data-preventa="${p.id}">Reservar (${gs(p.precio_desde)})</button>`
      : `<button class="btn btn-ghost" disabled>Requiere nivel ${p.tier_min}+</button>`;
    return `
      <div class="card">
        <div class="thumb">${artSvg(p.id, p.evento, "🎟")}</div>
        <div class="body">
          <span class="chip ${p.habilitada ? "on" : ""}">${p.fecha} · ${p.sede}</span>
          <h4>${p.evento}</h4>
          <p>Desde ${gs(p.precio_desde)} · ${p.stock} entradas en preventa</p>${btn}
        </div>
      </div>`;
  }
  async function reservar(id) {
    try { const r = await api("/preventas/" + id + "/reservar", { method: "POST", body: { cantidad: 1 } });
      toast("Reserva confirmada ✓"); vPreventas(); }
    catch (e) { toast(e.message); }
  }

  // ─── Carnet ──────────────────────────────────────────────────────────────────
  async function vCarnet() {
    view().innerHTML = '<p class="muted">Cargando…</p>';
    try {
      const { carnet } = await api("/carnet");
      view().innerHTML = `
        <div class="section" style="border:none;padding-top:8px">
          <h2>Mi carnet digital</h2>
          <p class="lead">Mostralo en el estadio y en la tienda oficial.</p>
          <div class="carnet" style="border-color:${carnet.color}">
            <div class="top">
              <img src="/assets/logo.svg" width="42" alt="" />
              <span class="tier-name" style="color:${carnet.color}">${carnet.tier}</span>
            </div>
            <div>
              <div class="nom">${carnet.nombre}</div>
              <div class="num">${carnet.numero}</div>
            </div>
            <div class="foot">Socio desde ${new Date(carnet.desde).toLocaleDateString("es-PY")} · Olimpistas</div>
          </div>
        </div>`;
    } catch (e) {
      view().innerHTML = `<div class="section" style="border:none"><h2>Carnet no disponible</h2><p class="lead">${e.message}</p><a class="btn" href="/">Ver planes</a></div>`;
    }
  }

  init().catch((e) => { view().innerHTML = '<p class="error">' + e.message + "</p>"; });
})();
