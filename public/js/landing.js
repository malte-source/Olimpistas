/* landing.js — embudo de captación: registro gratis + upsell a Kids/Premium. */
(function () {
  const { api, precioTier, artSvg, toast, yo } = window.OLI;
  let CONFIG = null;
  let SESSION = null;
  let intentTier = null; // nivel que se quiso comprar antes de registrarse

  const ICONOS = { olimpista: "★", kids: "🎈", premium: "♛" };

  async function init() {
    CONFIG = await api("/config");
    SESSION = await yo();
    document.getElementById("heroTitle").textContent = CONFIG.brand.lema;
    document.getElementById("heroSub").textContent = CONFIG.brand.bajada;
    document.getElementById("heroCta").textContent = CONFIG.brand.ctaPrincipal;
    renderTiers();
    renderNav();
    wireModal();
    document.getElementById("heroCta").onclick = () => empezarGratis();
    document.querySelectorAll("[data-stub]").forEach((a) =>
      a.addEventListener("click", (e) => { e.preventDefault(); toast("Próximamente"); })
    );
    const pago = new URLSearchParams(location.search).get("pago_simulado");
    if (pago) confirmarSimulado(pago);
    initMundo();
  }

  // ─── Olimpistas en el mundo: contador + globo ───────────────────────────────
  async function initMundo() {
    let stats;
    try { stats = await api("/stats"); } catch { return; }
    animarContador(stats.total);
    document.getElementById("contadorPaises").textContent = stats.paises;
    renderTopPaises(stats.porPais);
    document.getElementById("globoCta").onclick = () => empezarGratis();
    esperarGlobe(() => {
      const gl = window.OLI_GLOBE.create(document.getElementById("globo"), { maxH: 600 });
      if (!gl) return;
      const puntos = (stats.puntos && stats.puntos.length) ? stats.puntos : stats.porPais;
      gl.setData(puntos);
      const foco = puntos[0] || { lat: -23.4, lng: -58.4 };
      gl.pov({ lat: foco.lat, lng: foco.lng, zoom: 2.4 });
    });
  }

  let _popT = null;
  function mostrarPopup(d) {
    const el = document.getElementById("globoPopup");
    if (!el) return;
    const lugar = d.ciudad ? `${d.ciudad}, ${d.pais}` : (d.pais || d.nombre || "");
    el.innerHTML = `<strong>${lugar}</strong><span>${Number(d.count).toLocaleString("es-PY")} Olimpista${d.count === 1 ? "" : "s"}</span>`;
    el.hidden = false;
    clearTimeout(_popT);
    _popT = setTimeout(() => { el.hidden = true; }, 4500);
  }

  function esperarGlobe(cb) {
    let n = 0;
    const t = setInterval(() => {
      if (window.OLI_GLOBE && window.maplibregl) { clearInterval(t); cb(); }
      else if (++n > 60) clearInterval(t); // ~6s máx; si no cargó, queda solo el contador
    }, 100);
  }

  function animarContador(target) {
    const el = document.getElementById("contadorNum");
    if (!el) return;
    // Basado en timers (no rAF) para que funcione incluso sin pintado/foco.
    const dur = 1400, t0 = Date.now();
    el.textContent = "0";
    const iv = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))).toLocaleString("es-PY");
      if (p >= 1) clearInterval(iv);
    }, 35);
    // Garantía del valor final por si el timer se ralentiza en segundo plano.
    setTimeout(() => { el.textContent = Number(target).toLocaleString("es-PY"); }, dur + 250);
  }

  function renderTopPaises(list) {
    const el = document.getElementById("topPaises");
    if (!list || !list.length) { el.innerHTML = '<p class="muted">Sé el primero en aparecer en el mapa.</p>'; return; }
    const top = list.slice(0, 8);
    el.innerHTML = "<h4>Top países</h4>" + top.map((p, i) =>
      `<div class="tp-row"><span>${i + 1}. ${p.nombre}</span><strong>${Number(p.count).toLocaleString("es-PY")}</strong></div>`
    ).join("");
  }

  function renderNav() {
    const btn = document.getElementById("accederBtn");
    if (SESSION) { btn.textContent = "Mi cuenta"; btn.onclick = () => (location.href = "/socio"); }
    else { btn.textContent = "Ingresar"; btn.onclick = () => openModal("login"); }
  }

  function empezarGratis() {
    if (SESSION) return (location.href = "/socio");
    openModal("registro");
  }

  function renderTiers() {
    const cont = document.getElementById("tiers");
    cont.innerHTML = CONFIG.tiers.map((t) => {
      const p = precioTier(t);
      const bullets = t.beneficios.map((b) => `<li>${b}</li>`).join("");
      return `
      <div class="tier">
        <div class="tier-card">
          <div class="art">${artSvg(t.slug, t.nombre, ICONOS[t.slug] || "●")}</div>
          ${t.destacado ? '<span class="badge">Empezá acá</span>' : ""}
          <div class="meta"><h3>${t.nombre}</h3><span>${t.subtitulo}</span></div>
        </div>
        <div class="price"><div class="big">${p.big}</div><div class="small">${p.small}</div></div>
        <button class="btn cta ${t.nivel === 0 ? "" : "btn-ghost"}" data-tier="${t.slug}">${t.cta}</button>
        <ul class="benefits">${bullets}</ul>
      </div>`;
    }).join("");
    cont.querySelectorAll("button[data-tier]").forEach((b) =>
      b.addEventListener("click", () => unirse(b.dataset.tier))
    );
  }

  async function unirse(tierSlug) {
    const tier = CONFIG.tiers.find((t) => t.slug === tierSlug);
    if (!SESSION) { intentTier = tierSlug; return openModal("registro"); }
    if (!tier || tier.nivel === 0) return (location.href = "/socio"); // ya sos Olimpista
    try {
      const r = await api("/membresia/unirse", { method: "POST", body: { tier: tierSlug } });
      if (r.gratis) return (location.href = "/socio");
      location.href = r.pago.urlPago; // simulado → /socio?pago_simulado=… | real → URL de PAGOPAR
    } catch (e) { toast(e.message); }
  }

  async function confirmarSimulado(pedidoId) {
    try { await api("/pagos/confirmar-simulado", { method: "POST", body: { pedidoId } }); location.href = "/socio"; }
    catch (e) { toast(e.message); }
  }

  // ─── Modal auth ────────────────────────────────────────────────────────────
  let mode = "registro";
  function openModal(m) { mode = m; syncModal(); document.getElementById("modalBg").classList.add("open"); }
  function closeModal() { document.getElementById("modalBg").classList.remove("open"); document.getElementById("modalError").textContent = ""; }

  function syncModal() {
    const reg = mode === "registro";
    document.getElementById("modalTitle").textContent = reg ? "Hacete Olimpista" : "Ingresar";
    document.getElementById("modalSub").textContent = reg ? "Creá tu cuenta gratis." : "Ingresá a tu cuenta de Olimpista.";
    document.getElementById("nombreField").style.display = reg ? "block" : "none";
    document.getElementById("submitBtn").textContent = reg ? "Crear cuenta gratis" : "Ingresar";
    document.getElementById("switchMode").innerHTML = reg
      ? '¿Ya sos Olimpista? <a id="switchLink">Ingresá</a>'
      : '¿No tenés cuenta? <a id="switchLink">Hacete Olimpista</a>';
    document.getElementById("switchLink").onclick = () => { mode = reg ? "login" : "registro"; syncModal(); };
  }

  function wireModal() {
    document.getElementById("modalBg").addEventListener("click", (e) => { if (e.target.id === "modalBg") closeModal(); });
    document.getElementById("submitBtn").addEventListener("click", submitAuth);
    document.getElementById("password").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); });
  }

  async function submitAuth() {
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const nombre = document.getElementById("nombre").value.trim();
    const errEl = document.getElementById("modalError");
    errEl.textContent = "";
    try {
      const path = mode === "registro" ? "/auth/registro" : "/auth/login";
      const body = mode === "registro" ? { email, password, nombre } : { email, password };
      SESSION = await api(path, { method: "POST", body });
      closeModal();
      const intent = intentTier; intentTier = null;
      const tier = intent && CONFIG.tiers.find((t) => t.slug === intent);
      if (tier && tier.nivel > 0) unirse(intent); // quería un nivel pago → al pago
      else location.href = "/socio";
    } catch (e) { errEl.textContent = e.message; }
  }

  init().catch((e) => { document.getElementById("heroSub").textContent = "Error: " + e.message; });
})();
