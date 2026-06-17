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

  // Formatea guaraníes: 49000 → "₲ 49.000"
  function gs(n) {
    if (n == null) return "";
    return "₲ " + Number(n).toLocaleString("es-PY");
  }

  // Precio mostrado por tier (replica el layout de Madridistas).
  function precioTier(t) {
    if (!t.precioAnio && !t.precioMes) return { big: "Gratis", small: "" };
    if (t.precioMes != null) {
      return { big: `Desde ${gs(t.precioMes)}/mes`, small: t.precioAnio ? `O desde ${gs(t.precioAnio)}/año` : "" };
    }
    return { big: `${gs(t.precioAnio)}/año`, small: "" };
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

  function toast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg; el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2600);
  }

  async function yo() {
    try { return await api("/auth/yo"); } catch { return null; }
  }

  return { api, gs, precioTier, artGradient, artSvg, toast, yo };
})();
