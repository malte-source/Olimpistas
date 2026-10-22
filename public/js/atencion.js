/* atencion.js — chat de atención del hincha (asistente con IA + persona del club).
   Un botón flotante abre un panel: lateral de 410 px en escritorio, pantalla completa en el móvil.
   La IA corre en el servidor; acá solo se muestran mensajes. Si una persona toma la conversación,
   el panel consulta cada pocos segundos mientras esté abierto (nunca en segundo plano). */
(function () {
  if (!window.OLI) return;
  const { api, esc, toast } = window.OLI;
  const LANG = window.OLI_I18N ? window.OLI_I18N.lang() : "es";
  const S = {
    es: {
      abrir: "Atención", titulo: "Atención Olimpistas", ia: "Asistente con IA · responde al instante", humano: "Agente del club · persona",
      asistente: "Asistente · IA", persona: "Atención del club", placeholder: "Escribí tu consulta…", enviar: "Enviar", cerrar: "Cerrar",
      bienvenida: "Hola, soy el asistente de Olimpistas. Contame en qué te ayudo.", pensando: "El asistente está escribiendo",
      esperando: "Una persona del club te va a responder acá mismo.", error: "No pudimos enviar tu mensaje. Probá de nuevo.", abrirLink: "Abrir",
    },
    en: {
      abrir: "Support", titulo: "Olimpistas Support", ia: "AI assistant · replies instantly", humano: "Club agent · person",
      asistente: "Assistant · AI", persona: "Club support", placeholder: "Type your question…", enviar: "Send", cerrar: "Close",
      bienvenida: "Hi, I'm the Olimpistas assistant. Tell me how I can help.", pensando: "The assistant is typing",
      esperando: "A person from the club will reply right here.", error: "We couldn't send your message. Try again.", abrirLink: "Open",
    },
  }[LANG === "en" ? "en" : "es"];

  let panel = null, lista = null, campo = null, sugBox = null, estado = "ia", abierto = false, timer = null, visto = new Set(), enviando = false;

  // Íconos del sprite propio (/assets/icons.svg · 10-iconos.md)
  const sp = (id, s, f) => `<svg class="ic" width="${s}" height="${s}" aria-hidden="true"><use href="/assets/icons.svg#i-${id}${f ? "-f" : ""}"/></svg>`;
  const ICO = { chat: sp("chat", 27, true), arriba: sp("enviar", 20), x: sp("cerrar", 24), check: sp("check-circulo", 20), persona: sp("persona", 20), pago: sp("pagar", 20) };

  function montar() {
    if (document.getElementById("atcFab")) return;
    const fab = document.createElement("button");
    fab.id = "atcFab"; fab.type = "button"; fab.className = "atc-fab"; fab.setAttribute("aria-label", S.abrir);
    fab.innerHTML = ICO.chat + '<span class="atc-fab-dot" aria-hidden="true"></span>';
    fab.addEventListener("click", abrir);
    document.body.appendChild(fab);

    panel = document.createElement("aside");
    panel.id = "atcPanel"; panel.className = "atc-panel"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", S.titulo); panel.hidden = true;
    panel.innerHTML = `
      <header class="atc-head">
        <span class="atc-sh"><img src="/assets/escudo-olimpia-blanco.png" alt="" height="26" /></span>
        <div class="atc-head-t"><b>${esc(S.titulo)}</b><span class="atc-estado"><i id="atcDot" class="atc-dot"></i><span id="atcEstado">${esc(S.ia)}</span></span></div>
        <button type="button" class="atc-x" id="atcX" aria-label="${esc(S.cerrar)}">${ICO.x}</button>
      </header>
      <div class="atc-fr" aria-hidden="true"></div>
      <div class="atc-lista" id="atcLista" role="log" aria-live="polite"></div>
      <div class="atc-sug" id="atcSug"></div>
      <form class="atc-form" id="atcForm" autocomplete="off">
        <input id="atcCampo" type="text" maxlength="500" placeholder="${esc(S.placeholder)}" aria-label="${esc(S.placeholder)}" />
        <button type="submit" class="atc-send" aria-label="${esc(S.enviar)}">${ICO.arriba}</button>
      </form>`;
    document.body.appendChild(panel);
    lista = panel.querySelector("#atcLista"); campo = panel.querySelector("#atcCampo"); sugBox = panel.querySelector("#atcSug");
    panel.querySelector("#atcX").addEventListener("click", cerrar);
    panel.querySelector("#atcForm").addEventListener("submit", (e) => { e.preventDefault(); enviar(campo.value); });
    sugBox.addEventListener("click", (e) => { const b = e.target.closest("button[data-sug]"); if (b) enviar(b.dataset.sug); });
    lista.addEventListener("click", (e) => { const a = e.target.closest("a[data-tj]"); if (a && /^\/miembro/.test(a.getAttribute("href") || "")) cerrar(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && abierto) cerrar(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) parar(); else if (abierto && estado === "humano") esperar(); });
  }

  function pintarEstado() {
    const humano = estado === "humano";
    panel.querySelector("#atcEstado").textContent = humano ? S.humano : S.ia;
    panel.querySelector("#atcDot").className = "atc-dot" + (humano ? " humano" : "");
  }

  function burbuja(m) {
    if (visto.has(m.id)) return;
    visto.add(m.id);
    let h = "";
    if (m.de === "hincha") h = `<div class="atc-msg yo"><div class="atc-b">${esc(m.texto)}</div></div>`;
    else if (m.de === "ia") h = `<div class="atc-msg ia"><span class="atc-et">${esc(S.asistente)}</span><div class="atc-b">${esc(m.texto)}</div></div>`;
    else if (m.de === "humano") h = `<div class="atc-msg hu"><span class="atc-et">${esc(((m.meta && m.meta.agente) || "").replace(/[-_.]+/g, " ") || S.persona)} · ${esc(S.persona)}</span><div class="atc-b">${esc(m.texto)}</div></div>`;
    else if (m.de === "sistema") h = `<div class="atc-sis">${esc(m.texto)}</div>`;
    else if (m.de === "tarjeta") {
      const t = m.meta || {}, url = typeof t.url === "string" && /^(\/|https:\/\/)/.test(t.url) ? t.url : "";
      const ic = t.tipo === "derivado" ? ICO.persona : t.tipo === "pago_subasta" ? ICO.pago : ICO.check;
      h = `<div class="atc-tj"><span class="atc-tj-ic">${ic}</span><span class="atc-tj-t">${esc(m.texto)}</span>${url ? `<a data-tj class="atc-tj-a" href="${esc(url)}"${/^https:/.test(url) ? ' target="_blank" rel="noopener"' : ""}>${esc(S.abrirLink)}</a>` : ""}</div>`;
    }
    lista.insertAdjacentHTML("beforeend", h);
  }
  const abajo = () => { lista.scrollTop = lista.scrollHeight; };

  function pintarSugerencias(items) {
    sugBox.innerHTML = (items || []).map((t) => `<button type="button" class="atc-pill" data-sug="${esc(t)}">${esc(t)}</button>`).join("");
  }

  async function cargar() {
    try {
      const d = await api("/atencion/chat");
      estado = d.conversacion ? d.conversacion.estado : "ia";
      lista.innerHTML = ""; visto = new Set();
      if (!d.mensajes.length) lista.insertAdjacentHTML("beforeend", `<div class="atc-msg ia"><span class="atc-et">${esc(S.asistente)}</span><div class="atc-b">${esc(S.bienvenida)}</div></div>`);
      d.mensajes.forEach(burbuja);
      pintarSugerencias(d.mensajes.length ? [] : d.sugerencias);
      pintarEstado(); abajo();
      if (estado === "humano") esperar();
    } catch (e) { toast(S.error); }
  }

  function escribiendo(si) {
    const ya = lista.querySelector(".atc-typing");
    if (si && !ya) { lista.insertAdjacentHTML("beforeend", `<div class="atc-typing" role="status" aria-label="${esc(S.pensando)}"><i></i><i></i><i></i></div>`); abajo(); }
    if (!si && ya) ya.remove();
  }

  async function enviar(texto) {
    texto = String(texto || "").trim();
    if (!texto || enviando) return;
    enviando = true; campo.value = ""; sugBox.innerHTML = "";
    burbuja({ id: "tmp-" + Date.now(), de: "hincha", texto });
    escribiendo(estado !== "humano"); abajo();
    try {
      const d = await api("/atencion/chat", { method: "POST", body: { texto } });
      escribiendo(false);
      // el mensaje propio ya se pintó (tmp): se marca el real como visto y se muestran solo las respuestas
      const propio = d.mensajes.find((m) => m.de === "hincha"); if (propio) visto.add(propio.id);
      d.mensajes.filter((m) => m.de !== "hincha").forEach(burbuja);
      estado = d.estado; pintarEstado();
      if (estado === "humano") { if (!d.mensajes.some((m) => m.de !== "hincha")) burbuja({ id: "esp-" + Date.now(), de: "sistema", texto: S.esperando }); esperar(); }
      abajo();
    } catch (e) { escribiendo(false); toast(e.message || S.error); }
    finally { enviando = false; campo.focus(); }
  }

  // Con una persona: consulta cada 6 s mientras el panel está abierto y visible.
  function parar() { if (timer) clearInterval(timer); timer = null; }
  function esperar() {
    parar();
    timer = setInterval(async () => {
      if (!abierto || document.hidden) return parar();
      try {
        const d = await api("/atencion/chat");
        const nuevo = d.mensajes.filter((m) => !visto.has(m.id));
        nuevo.forEach(burbuja);
        const e = d.conversacion ? d.conversacion.estado : "ia";
        if (e !== estado) { estado = e; pintarEstado(); }
        if (nuevo.length) abajo();
        if (estado !== "humano") parar();
      } catch (err) { /* sin conexión: se reintenta en la próxima vuelta */ }
    }, 6000);
  }

  function abrir() {
    if (!panel) montar();
    abierto = true; panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add("abierto"));
    document.getElementById("atcFab").classList.add("oculto");
    cargar();
    setTimeout(() => campo && campo.focus(), 200);
  }
  function cerrar() {
    abierto = false; parar(); panel.classList.remove("abierto");
    setTimeout(() => { if (!abierto) panel.hidden = true; }, 250);
    const f = document.getElementById("atcFab"); f.classList.remove("oculto"); f.focus();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", montar); else montar();
})();
