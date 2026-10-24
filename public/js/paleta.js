/* paleta.js — buscador global del área de socio (Ctrl/⌘ + K). Ir a una pantalla, buscar un beneficio o ejecutar una acción
   ("Mostrar mi QR", "Hablar con una persona") sin tocar el mouse. Pensado para escritorio; en el celular no estorba. */
(function () {
  const OLI = window.OLI;
  if (!OLI || !OLI.api) return;
  const T = (k) => (window.OLI_I18N ? window.OLI_I18N.t(k) : k);
  const esc = OLI.esc;
  const norm = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const nav = () => OLI.nav || {};

  let caja = null, abierto = false, previo = null, activo = 0, lista = [], beneficios = null, beneficiosAt = 0;

  function pantallas() {
    const ir = (tab, seg) => () => nav().ir && nav().ir(tab, seg);
    return [
      { g: "ir", t: T("tab_inicio"), run: ir("inicio") },
      { g: "ir", t: T("tab_partidos"), run: ir("partidos") },
      { g: "ir", t: T("tab_carnet"), run: ir("carnet") },
      { g: "ir", t: T("tab_beneficios"), run: ir("beneficios") },
      { g: "ir", t: T("tab_puntos"), run: ir("puntos") },
      { g: "ir", t: T("hi_h"), run: ir("historia") },
      { g: "ir", t: T("pal_perfil"), run: ir("perfil") },
      { g: "ir", t: T("pal_subastas"), run: ir("descubrir", "subastas") },
      { g: "ir", t: T("pal_sorteos"), run: ir("descubrir", "sorteos") },
      { g: "ir", t: T("pal_preventas"), run: ir("descubrir", "preventas") },
      { g: "ir", t: T("pal_penas"), run: ir("descubrir", "penas") },
    ];
  }
  function acciones() {
    const a = [
      { g: "acc", t: T("pal_qr"), k: "qr carnet codigo caja", run: () => nav().ir && nav().ir("carnet") },
      { g: "acc", t: T("pal_persona"), k: "chat ayuda soporte humano atencion", run: () => { const f = document.getElementById("atcFab"); if (f) f.click(); } },
    ];
    if (nav().esSocio && !nav().esSocio()) a.push({ g: "acc", t: T("pal_validar"), k: "socio cedula validar club", run: () => nav().validarSocio && nav().validarSocio() });
    if (OLI.setThemePref) for (const [pref, k] of [["auto", "pal_t_auto"], ["claro", "pal_t_claro"], ["oscuro", "pal_t_oscuro"]]) a.push({ g: "acc", t: T(k), k: "tema apariencia modo", run: () => OLI.setThemePref(pref, true) });
    a.push({ g: "acc", t: T("pal_salir"), k: "salir logout cerrar sesion", run: () => nav().logout && nav().logout() });
    return a;
  }
  async function cargarBeneficios() {
    if (beneficios && Date.now() - beneficiosAt < 300000) return beneficios;
    try { const r = await OLI.api("/beneficios"); beneficios = (r && r.items) || []; beneficiosAt = Date.now(); } catch (e) { beneficios = beneficios || []; }
    return beneficios;
  }

  function filtrar(q) {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    const coincide = (txt) => !toks.length || toks.every((t) => norm(txt).includes(t));
    const out = [];
    for (const p of pantallas()) if (coincide(p.t)) out.push(p);
    for (const a of acciones()) if (coincide(a.t + " " + (a.k || ""))) out.push(a);
    if (toks.length) for (const b of (beneficios || [])) {
      if (coincide([b.comercio_nombre, b.comercio_rubro, b.comercio_ciudad, b.titulo, b.valor].join(" "))) {
        out.push({ g: "ben", t: (b.comercio_nombre || "") + (b.valor ? " · " + b.valor : ""), s: [b.titulo, b.comercio_ciudad].filter(Boolean).join(" · "), run: () => nav().verBeneficio && nav().verBeneficio(b.id) });
      }
      if (out.filter((x) => x.g === "ben").length >= 8) break;
    }
    return out;
  }

  function pintar() {
    const q = caja.querySelector("input").value;
    lista = filtrar(q);
    activo = Math.min(activo, Math.max(0, lista.length - 1));
    const ul = caja.querySelector("[role=listbox]");
    const ETQ = { ir: T("pal_ir"), acc: T("pal_acciones"), ben: T("tab_beneficios") };
    let ant = "", h = "";
    lista.forEach((it, i) => {
      if (it.g !== ant) { ant = it.g; h += `<li class="pal-g" role="presentation">${esc(ETQ[it.g])}</li>`; }
      h += `<li class="pal-it" role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === activo}">${esc(it.t)}${it.s ? `<small>${esc(it.s)}</small>` : ""}</li>`;
    });
    ul.innerHTML = h || `<li class="pal-vacio" role="presentation">${esc(T("pal_sin"))}</li>`;
    const inp = caja.querySelector("input");
    inp.setAttribute("aria-activedescendant", lista.length ? "pal-" + activo : "");
    const el = ul.querySelector("#pal-" + activo); if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }

  function cerrar() {
    if (!abierto) return;
    abierto = false; caja.hidden = true; document.body.classList.remove("pal-abierta");
    if (previo && previo.focus) { try { previo.focus(); } catch (e) {} }
  }
  function ejecutar(i) {
    const it = lista[i]; if (!it) return;
    cerrar();
    setTimeout(() => { try { it.run(); } catch (e) {} }, 30);
  }

  function armar() {
    caja = document.createElement("div");
    caja.className = "pal"; caja.hidden = true;
    caja.innerHTML = `<div class="pal-fondo" data-x></div>
      <div class="pal-caja" role="dialog" aria-modal="true" aria-label="${esc(T("pal_titulo"))}">
        <input type="text" role="combobox" aria-expanded="true" aria-controls="palLista" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="${esc(T("pal_ph"))}" aria-label="${esc(T("pal_ph"))}" />
        <ul id="palLista" role="listbox" aria-label="${esc(T("pal_titulo"))}"></ul>
        <p class="pal-pie"><kbd>↑</kbd><kbd>↓</kbd> ${esc(T("pal_mover"))} · <kbd>Enter</kbd> ${esc(T("pal_elegir"))} · <kbd>Esc</kbd> ${esc(T("pal_cerrar"))}</p>
      </div>`;
    document.body.appendChild(caja);
    const inp = caja.querySelector("input");
    inp.addEventListener("input", () => { activo = 0; pintar(); });
    caja.addEventListener("click", (e) => {
      if (e.target.closest("[data-x]")) return cerrar();
      const it = e.target.closest(".pal-it"); if (it) ejecutar(Number(it.dataset.i));
    });
    caja.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); cerrar(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); activo = lista.length ? (activo + 1) % lista.length : 0; pintar(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); activo = lista.length ? (activo - 1 + lista.length) % lista.length : 0; pintar(); }
      else if (e.key === "Enter") { e.preventDefault(); ejecutar(activo); }
      else if (e.key === "Tab") { e.preventDefault(); inp.focus(); }   // el foco no sale del cuadro mientras está abierto
    });
  }

  function abrir() {
    if (!caja) armar();
    if (abierto) return;
    previo = document.activeElement; abierto = true; activo = 0;
    caja.hidden = false; document.body.classList.add("pal-abierta");
    const inp = caja.querySelector("input"); inp.value = ""; pintar(); inp.focus();
    cargarBeneficios().then(() => { if (abierto) pintar(); });
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === "k") { e.preventDefault(); abierto ? cerrar() : abrir(); }
  });
  document.addEventListener("click", (e) => { if (e.target.closest("#sideBuscar")) abrir(); });
  OLI.paleta = { abrir, cerrar };
})();
