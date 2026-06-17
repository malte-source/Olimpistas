/* landing.js — renderiza la landing de Olimpistas y maneja registro/login. */
(function () {
  const { api, precioTier, artSvg, toast, yo } = window.OLI;
  let CONFIG = null;
  let SESSION = null;
  let intentTier = null; // tier que el visitante quiso unir antes de loguearse

  const ICONOS = { oro: "★", plata: "◆", olimpista: "●", junior: "🎈" };

  async function init() {
    CONFIG = await api("/config");
    SESSION = await yo();
    document.getElementById("heroTitle").textContent = CONFIG.brand.lema;
    document.getElementById("heroSub").textContent = CONFIG.brand.bajada;
    renderTiers();
    renderNav();
    wireModal();
    // ¿Vuelve de un pago simulado?
    const pago = new URLSearchParams(location.search).get("pago_simulado");
    if (pago) confirmarSimulado(pago);
  }

  function renderNav() {
    const btn = document.getElementById("accederBtn");
    if (SESSION) {
      btn.textContent = "Mi cuenta";
      btn.onclick = () => (location.href = "/socio");
    } else {
      btn.textContent = "Acceder";
      btn.onclick = () => openModal("login");
    }
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
          ${t.destacado ? '<span class="badge">Más popular</span>' : ""}
          <div class="meta"><h3>${t.nombre}</h3><span>${t.subtitulo}</span></div>
        </div>
        <div class="price"><div class="big">${p.big}</div><div class="small">${p.small}</div></div>
        <button class="btn cta" data-tier="${t.slug}">${t.cta}</button>
        <ul class="benefits">${bullets}</ul>
      </div>`;
    }).join("");

    cont.querySelectorAll("button[data-tier]").forEach((b) =>
      b.addEventListener("click", () => unirse(b.dataset.tier))
    );
  }

  async function unirse(tierSlug) {
    if (!SESSION) { intentTier = tierSlug; return openModal("registro"); }
    try {
      const r = await api("/membresia/unirse", { method: "POST", body: { tier: tierSlug, ciclo: "anio" } });
      if (r.gratis) { toast("¡Listo! Ya sos " + tierSlug); return setTimeout(() => (location.href = "/socio"), 900); }
      // Pago: en modo simulado urlPago es interno; en real, redirige a PAGOPAR.
      if (r.pago?.urlPago?.startsWith("http")) location.href = r.pago.urlPago;
      else location.href = r.pago.urlPago; // /socio?pago_simulado=...
    } catch (e) { toast(e.message); }
  }

  async function confirmarSimulado(pedidoId) {
    try {
      await api("/pagos/confirmar-simulado", { method: "POST", body: { pedidoId } });
      location.href = "/socio";
    } catch (e) { toast(e.message); }
  }

  // ─── Modal auth ────────────────────────────────────────────────────────────
  let mode = "login";
  function openModal(m) { mode = m; syncModal(); document.getElementById("modalBg").classList.add("open"); }
  function closeModal() { document.getElementById("modalBg").classList.remove("open"); document.getElementById("modalError").textContent = ""; }

  function syncModal() {
    const reg = mode === "registro";
    document.getElementById("modalTitle").textContent = reg ? "Hacete Olimpista" : "Acceder";
    document.getElementById("modalSub").textContent = reg
      ? "Creá tu cuenta para unirte a un plan." : "Ingresá para gestionar tu membresía.";
    document.getElementById("nombreField").style.display = reg ? "block" : "none";
    document.getElementById("submitBtn").textContent = reg ? "Crear cuenta" : "Ingresar";
    document.getElementById("switchMode").innerHTML = reg
      ? '¿Ya tenés cuenta? <a id="switchLink">Ingresá</a>'
      : '¿No tenés cuenta? <a id="switchLink">Registrate</a>';
    document.getElementById("switchLink").onclick = () => { mode = reg ? "login" : "registro"; syncModal(); };
  }

  function wireModal() {
    document.getElementById("modalBg").addEventListener("click", (e) => {
      if (e.target.id === "modalBg") closeModal();
    });
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
      renderNav();
      if (intentTier) { const t = intentTier; intentTier = null; unirse(t); }
      else location.href = "/socio";
    } catch (e) { errEl.textContent = e.message; }
  }

  init().catch((e) => { document.getElementById("heroSub").textContent = "Error: " + e.message; });
})();
