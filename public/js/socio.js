/* socio.js — área de socio: perfil + progreso, membresía, contenido, sorteos,
   preventas, carnet. Bilingüe (OLI_I18N) + UX premium (skeletons, transiciones,
   anillo de progreso). El foco del embudo es completar el perfil. */
(function () {
  const { api, esc, gs, gsUsdRef, artSvg, toast, yo, carnet: carnetHTML, makeQR, fotoModal, icon } = window.OLI;
  const T = (k) => (window.OLI_I18N ? window.OLI_I18N.t(k) : k);
  const LANG = window.OLI_I18N ? window.OLI_I18N.lang() : "es";
  const LOC = LANG === "en" ? "en-US" : "es-PY";
  let SESSION = null; // { socio, membresia, progreso }
  let CONFIG = null;  // { paises: [{iso,nombre}], ... }
  // ─── Router real (pushState/popstate): F5, atrás/adelante y compartir un link
  // deben reflejar la vista actual. Esquema: /miembro, /miembro/carnet,
  // /miembro/beneficios, /miembro/perfil, /miembro/descubrir(/<segmento>)(/subastas/<id>).
  let curTab = "inicio", curSubId = null;
  const TABS_RUTA = ["inicio", "partidos", "carnet", "beneficios", "puntos", "perfil", "descubrir"];
  const PESTANAS = ["inicio", "partidos", "carnet", "beneficios", "puntos"]; // las 5 de la barra; perfil y descubrir abren con "‹ Inicio"
  const SEGS_RUTA = ["subastas", "sorteos", "preventas", "media", "penas"];
  function parseRuta(pathname) {
    const parts = pathname.replace(/^\/miembro\/?/, "").split("/").filter(Boolean);
    if (!parts.length || !TABS_RUTA.includes(parts[0])) return { tab: "inicio" };
    if (parts[0] !== "descubrir") return { tab: parts[0] };
    const seg = SEGS_RUTA.includes(parts[1]) ? parts[1] : "subastas";
    return { tab: "descubrir", seg, subId: seg === "subastas" && parts[2] ? parts[2] : null };
  }
  function rutaActual() {
    if (curTab !== "descubrir") return curTab === "inicio" ? "/miembro" : "/miembro/" + curTab;
    if (descSeg === "subastas") return curSubId ? "/miembro/descubrir/subastas/" + curSubId : "/miembro/descubrir";
    return "/miembro/descubrir/" + descSeg;
  }
  function syncUrl(replace) {
    const p = rutaActual();
    if (location.pathname === p) return; // ya refleja el estado, no ensuciar el historial
    history[replace ? "replaceState" : "pushState"]({}, "", p);
  }
  let perfilPunto = { lat: null, lng: null }; // ubicación exacta elegida
  let perfilGlobo = null;
  const view = () => document.getElementById("view");
  // Contenido montable: las vistas de Descubrir (subastas/sorteos/preventas/media) se
  // renderizan dentro de #descHost cuando estamos en el hub; si no, ocupan todo #view.
  let _contentHost = null;
  const cv = () => _contentHost || view();
  const fecha = (d) => new Date(d).toLocaleDateString(LOC, { year: "numeric", month: "long", day: "numeric" });
  // "Pagá antes del 24 de octubre, 15:30" — y si falta menos de 24 h se marca como último día.
  const fechaHoraCorta = (d) => new Date(d).toLocaleString(LOC, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const plazoPagoHtml = (vence, ronda) => {
    if (!vence) return "";
    const urgente = new Date(vence).getTime() - Date.now() < 24 * 3600000;
    return `<span class="sub-plazo${urgente ? " urg" : ""}">${urgente ? T("m_sub_plazo_ult") + " " : ""}${T("m_sub_vence")} <b>${fechaHoraCorta(vence)}</b></span>${ronda === 2 ? `<span class="sub-plazo-r2">${T("m_sub_ronda2_txt")}</span>` : ""}`;
  };
  const _previewQR = (() => { try { return makeQR("https://www.olimpistas.com"); } catch (e) { return ""; } })();

  // Skeleton de carga (en vez de "Cargando…").
  function skeleton(cards) {
    const c = cards == null ? 3 : cards;
    return `<div class="section" style="border:none;padding-top:8px">
      <div class="sk sk-h"></div><div class="sk sk-line"></div>
      ${c ? `<div class="grid-3">${'<div class="sk sk-card"></div>'.repeat(c)}</div>` : ""}</div>`;
  }
  const vacio = (txt) => `<div class="empty"><div class="empty-ic">${icon("calendar", { size: 36 })}</div><p>${txt}</p></div>`;

  async function init() {
    SESSION = await yo();
    if (!SESSION) { location.href = "/"; return; }
    CONFIG = await api("/config").catch(() => ({ paises: [] }));
    perfilPunto = { lat: SESSION.socio.lat ?? null, lng: SESSION.socio.lng ?? null };
    window.__oliSesion = true; // desde acá, cambiar la apariencia también se guarda en la cuenta
    if (SESSION.socio.tema) OLI.setThemePref(SESSION.socio.tema, false);
    renderHeader();
    initEncabezadoMovil();
    initTirarParaActualizar();
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => activar(t.dataset.tab)));
    document.getElementById("mBack").addEventListener("click", (e) => { e.preventDefault(); activar("inicio"); });
    pintarSideTema();
    document.addEventListener("oli-theme", pintarSideTema);
    window.addEventListener("resize", moveTabInd, { passive: true });
    // Si la tipografía todavía no había cargado cuando se posicionó la pastilla la
    // primera vez, el ancho de cada pestaña cambia al entrar la fuente — recalcular.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveTabInd).catch(() => {});
    // Candados vivos: cualquier botón bloqueado (sorteo/preventa/beneficio/subasta) abre
    // el momento de upsell (explica qué desbloquea + ofrece la vía gratis de socio),
    // en vez de mandar directo a la pasarela de pago sin contexto.
    // Socio no se compra (se otorga al validar cédula) — si el candado pide "socio",
    // el momento correcto es la validación gratis, no un botón de compra que el
    // backend siempre rechaza con 403.
    view().addEventListener("click", (e) => { const b = e.target.closest("[data-upsell-cta]"); if (!b) return; if (b.dataset.upsellCta === "socio") validarSocioModal(); else mostrarUpsell(b.dataset.upsellCta, b.dataset.upsellCtx); });

    const pago = new URLSearchParams(location.search).get("pago_simulado");
    if (pago) {
      try { await api("/pagos/confirmar-simulado", { method: "POST", body: { pedidoId: pago } }); toast(T("m_pago_ok")); }
      catch (e) { toast(e.message); }
      history.replaceState({}, "", "/miembro");
      SESSION = await yo();
    }

    // Retorno desde PAGOPAR (?pago=<hash>). El webhook activa la membresía y puede
    // demorar ~1-2 min → consultamos el estado unas veces para reflejarlo apenas confirme.
    const pagoHash = new URLSearchParams(location.search).get("pago");
    if (pagoHash) {
      let confirmado = false;
      for (let i = 0; i < 5 && !confirmado; i++) {
        try { const r = await api("/pagos/estado?hash=" + encodeURIComponent(pagoHash)); confirmado = !!r.pagado; } catch (e) {}
        if (!confirmado) await new Promise((res) => setTimeout(res, 2500));
      }
      toast(confirmado ? T("m_pago_ok") : T("m_pago_pendiente"));
      history.replaceState({}, "", "/miembro");
      SESSION = await yo();
    }
    renderProgreso();
    renderBannerSocio();
    // Deep-link por query param (viene de fuera: página de subasta, email, /?intent=pujar):
    // gana sobre la ruta del path porque expresa una intención explícita y puntual.
    // Se normaliza a la URL canónica del router (/miembro/descubrir/subastas/<id>).
    const subDeep = new URLSearchParams(location.search).get("sub");
    if (subDeep) {
      descSeg = "subastas"; _deepSub = subDeep;
      activar("descubrir", { fromRoute: true }); // syncUrl() abajo normaliza a la URL canónica
    } else {
      // Sin query param: la ruta actual manda (carga directa, F5, o link compartido).
      const ruta = parseRuta(location.pathname);
      if (ruta.tab === "descubrir") { descSeg = ruta.seg; if (ruta.subId) _deepSub = ruta.subId; }
      activar(ruta.tab, { fromRoute: true });
    }
    window.addEventListener("popstate", () => {
      const ruta = parseRuta(location.pathname);
      if (ruta.tab === "descubrir") { descSeg = ruta.seg; if (ruta.subId) _deepSub = ruta.subId; }
      activar(ruta.tab, { fromRoute: true });
    });
  }

  function activar(tab, opts) {
    opts = opts || {};
    window.scrollTo(0, 0); // si venías scrolleado, el título de la pestaña nueva no debe quedar tapado por el header fijo
    if (typeof stopSub === "function") stopSub();   // corta polling de subastas al cambiar de tab
    detenerQrBeneficios();                          // y el QR rotativo del carnet
    _contentHost = null;                            // fuera de Descubrir el contenido ocupa todo #view
    curTab = tab; curSubId = null;
    // fromRoute (init/popstate): normaliza con replace si hiciera falta, sin nueva entrada.
    // Navegación desde la UI (click): agrega una entrada de historial nueva.
    syncUrl(!!opts.fromRoute);
    document.querySelectorAll(".tab").forEach((t) => {
      const on = t.dataset.tab === tab;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      const u = t.querySelector("use"); if (u) u.setAttribute("href", "/assets/icons.svg#i-" + t.dataset.tab + (on ? "-f" : "")); // ícono relleno en la activa
    });
    document.body.dataset.tab = tab;
    const back = document.getElementById("mBack"); if (back) back.hidden = PESTANAS.includes(tab);
    moveTabInd();
    const conVista = (fn) => (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? document.startViewTransition(() => { fn(); }) /* sin devolver la promesa: la transición no espera a los datos de la vista */ : fn());
    conVista(({ inicio: vInicio, partidos: vPartidos, carnet: vCarnet, beneficios: vBeneficios, puntos: vPuntos, descubrir: vDescubrir, perfil: vPerfil }[tab] || vInicio));
  }

  // Pulido PRO: pill deslizante bajo el tab activo (solo mobile) + borde glass al hacer scroll.
  // requestAnimationFrame (no setTimeout(0)): garantiza que el layout ya se recalculó
  // (cambio de clase .active, contenido nuevo) antes de medir posiciones — con
  // setTimeout(0) a veces medía ANTES de que el navegador terminara de acomodar
  // todo, y la pastilla quedaba en la posición de la pestaña anterior.
  function moveTabInd() {
    requestAnimationFrame(() => {
      const bar = document.getElementById("tabs"), ind = document.getElementById("tabInd");
      const act = bar && bar.querySelector(".tab.active");
      if (ind) ind.style.opacity = act ? "1" : "0";   // perfil y descubrir no son pestañas
      if (!bar || !ind || !act) return;
      const br = bar.getBoundingClientRect(), ar = act.getBoundingClientRect();
      ind.style.transform = "translateX(" + Math.round(ar.left - br.left + ar.width / 2 - 28) + "px)";
    });
  }

  async function logout() { try { await api("/auth/logout", { method: "POST" }); } finally { location.href = "/"; } }
  async function refrescar() { SESSION = await yo(); renderProgreso(); renderHeader(); renderBannerSocio(); }

  // ─── Inicio (home): orden fijo — saludo → urgente → mis cosas → contenido del
  // club → próximo escalón. Bloques vacíos desaparecen, el orden nunca cambia. ──
  async function vInicio() {
    const s = SESSION.socio;
    const nombre = esc((String(s.nombre || s.email || "").trim().split(" ")[0]) || "Olimpista");
    view().innerHTML = skeleton(2);
    const [subsR, sorteosR, preventasR, encsR, ahorroR, puntosR, penasR] = await Promise.all([
      api("/subastas").catch(() => ({ items: [] })),
      api("/sorteos").catch(() => ({ items: [] })),
      api("/preventas").catch(() => ({ items: [] })),
      api("/encuestas").catch(() => ({ items: [] })),
      api("/beneficios/ahorro").catch(() => null),
      api("/puntos").catch(() => null),
      api("/penas").catch(() => null),
    ]);
    const subaViva = (subsR.items || []).find((x) => x.estado === "activa");
    const nivelTxt = "Olimpista " + (TIER_LBL[(SESSION.membresia && SESSION.membresia.tier_slug) || "olimpista"] || "").replace(/^Olimpista$/, "").trim();
    const sorteosActivos = (sorteosR.items || []).filter((sor) => sor.estado === "activa");

    // ── Urgente: subasta o sorteo activo, el que cierre antes (hoy solo se miraba
    // la subasta — un sorteo activo se promueve acá si su cierre es más próximo). ──
    const candidatos = [];
    if (subaViva) candidatos.push({ tipo: "subasta", data: subaViva, cierre: new Date(subaViva.termina).getTime() });
    sorteosActivos.forEach((sor) => { if (sor.cierra) candidatos.push({ tipo: "sorteo", data: sor, cierre: new Date(sor.cierra + "T23:59:59").getTime() }); });
    candidatos.sort((a, b) => a.cierre - b.cierre);
    const urgente = candidatos[0] || null;
    const urgenteSorteo = urgente && urgente.tipo === "sorteo" ? urgente.data : null;
    const destacado = !urgente || urgente.tipo === "subasta" ? "" : destacadoSorteo(urgente.data);

    // ── Mis cosas: filas, no grid de íconos — sorteos en los que ya participo,
    // el estado de mi perfil, mi carnet, invitar a un amigo. ──
    const misSorteos = sorteosActivos.filter((sor) => sor.participando && sor !== urgenteSorteo);
    const cosas = [];
    cosas.push(...misSorteos.map((sor) => iniNov(icon("gift", { size: 22 }), T("tab_sorteos"), sor.titulo, "sorteos")));
    cosas.push(iniNov(icon("credit-card", { size: 22 }), T("tab_carnet"), T("why_carnet_d"), "", "carnet"));
    cosas.push(iniNovAccion(icon("share-2", { size: 22 }), T("m_ini_invitar_h"), T("m_ini_invitar_p"), "iniInvitar"));

    // ── Contenido del club: encuesta abierta + novedades (sorteo/preventa que no
    // estén ya cubiertos arriba) + media, siempre. ──
    const enc = (encsR.items || []).find((x) => !x.respondida) || null;
    const sorteoNovedad = sorteosActivos.find((sor) => !sor.participando && sor !== urgenteSorteo) || null;
    const hoyIso = new Date().toISOString().slice(0, 10);
    const preventa = (preventasR.items || []).find((p) => !p.fecha || p.fecha >= hoyIso) || null;
    const club = [];
    if (sorteoNovedad) club.push(iniNov(icon("gift", { size: 22 }), T("tab_sorteos"), sorteoNovedad.titulo, "sorteos"));
    if (preventa) club.push(iniNov(icon("ticket", { size: 22 }), T("tab_preventas"), preventa.evento, "preventas"));
    club.push(iniNov(icon("play", { size: 22 }), T("tab_media"), T("m_media_h"), "media"));

    // ── Próximo escalón: solo para quien todavía no validó su condición de socio
    // (nunca a un Socio ya validado) — invita a ver lo que se suma al subir. ──
    const escalon = escalonCard();

    view().innerHTML = `<div class="section" style="border:none;padding-top:8px">
      <h2 class="ini-hi">${T("m_hola")}, ${nombre}</h2>
      <p class="lead">${T("m_ini_p")}</p>
      ${destacado}
      <p class="eyebrow-ini">${T("m_ini_mis_cosas")}</p>
      <div class="wg-grid">${widgetsInicio(ahorroR, puntosR, penasR, subaViva, nivelTxt)}</div>
      <div class="ini-feed" style="margin-top:14px"><div id="progreso"></div>${cosas.join("")}</div>
      <p class="eyebrow-ini">${T("m_ini_club")}</p>
      ${enc ? encuestaCard(enc) : ""}
      <div class="ini-feed">${club.join("")}</div>
      ${escalon}
    </div>`;
    view().querySelectorAll("[data-goto]").forEach((el) => el.addEventListener("click", () => { if (el.dataset.seg) descSeg = el.dataset.seg; activar(el.dataset.goto); }));
    renderProgreso();
    const inv = view().querySelector("#iniInvitar");
    if (inv) inv.onclick = async () => {
      const link = OLI.refLink(SESSION.socio && SESSION.socio.ref_codigo), txt = T("m_compartir_txt") + " " + link;
      try { if (navigator.share) await navigator.share({ title: "Olimpistas", text: txt }); else { await navigator.clipboard.writeText(link); toast(T("m_link_copiado")); } } catch (e) {}
    };
    const esc2 = view().querySelector("#iniEscalon");
    if (esc2) esc2.onclick = () => esc2.dataset.tier === "socio" ? validarSocioModal() : mostrarUpsell(esc2.dataset.tier, T("m_ini_escalon_p"));
    const card = view().querySelector(".enc-card");
    if (card && enc) bindEncuesta(card, enc);
  }
  // ─── Widgets de Inicio (04-pantallas): grilla auto-fill de 160 px, radio 26. Cada uno aparece solo si su dato cargó. ───
  function widgetsInicio(ahorro, puntos, penas, subViva, nivel) {
    const w = [];
    const anio = new Date().toLocaleDateString("en-CA", { timeZone: "America/Asuncion" }).slice(0, 4);
    if (ahorro) {
      w.push(`<button type="button" class="wg wg-2" data-goto="beneficios" aria-label="${T("m_wg_ahorro")}">
        <span class="wg-cab">${OLI.ic("ahorro", 18)}${T("m_wg_ahorro")}</span>
        <span class="wg-fila"><span class="wg-izq"><span class="wg-num">${gs(ahorro.mes || 0)}</span><span class="wg-sub">${T("m_wg_ahorro_mes")}</span></span>
          <span class="wg-der"><b>${gs(ahorro.anio != null ? ahorro.anio : ahorro.total || 0)}</b><small>${T("m_wg_ahorro_en")} ${anio}</small></span></span>
        <span class="wg-nota">${ahorro.canjes_mes ? (ahorro.canjes_mes + " " + T(ahorro.canjes_mes === 1 ? "m_wg_canje" : "m_wg_canjes")) : T("m_wg_ahorro_vacio")}</span>
      </button>`);
    }
    if (puntos) {
      const pct = Math.max(0, Math.min(100, Number(puntos.escalon && puntos.escalon.pct) || 0));
      w.push(`<button type="button" class="wg wg-pts" data-goto="puntos" aria-label="${T("tab_puntos")}">
        <span class="wg-cab">${T("tab_puntos")}</span>
        <span class="wg-ring" style="--p:${pct}"><b>${Number(puntos.saldo || 0).toLocaleString(LOC)}</b></span>
        <span class="wg-esc">${T("m_wg_escalon")} ${esc((puntos.escalon && puntos.escalon.nombre) || "")}</span>
      </button>`);
    }
    w.push(`<button type="button" class="wg" data-goto="partidos" aria-label="${T("tab_partidos")}">
      <span class="wg-eb wg-eb-partido">${T("m_wg_partido")}</span>
      <span class="wg-t">${T("m_wg_partido_t")}</span>
      <span class="wg-sub wg-pie">${T("m_wg_partido_p")}</span>
    </button>`);
    if (subViva) {
      w.push(`<button type="button" class="wg wg-2 wg-sub-viva" data-goto="descubrir" data-seg="subastas" aria-label="${esc(subViva.titulo)}">
        <span class="wg-thumb">${subastaMedia(subViva)}</span>
        <span class="wg-sv"><span class="wg-vivo">${T("m_sub_envivo")} · ${subViva.pujadores || 0} ${T("m_sub_pujando")}</span><span class="wg-t">${esc(subViva.titulo)}</span><span class="wg-sub">${gs(subViva.puja_actual)} · ${cdTexto(subViva.termina).txt}</span></span>
        ${OLI.ic("chevron-derecha", 18)}
      </button>`);
    }
    const items = penas && Array.isArray(penas.items) ? penas.items : null;
    if (items) {
      const mia = items.find((p) => p.es_tuya);
      w.push(`<button type="button" class="wg" data-goto="descubrir" data-seg="penas" aria-label="${T("m_wg_pena")}">
        <span class="wg-ic" style="background:#C2410C">${OLI.ic("pena", 22)}</span>
        <span class="wg-t wg-pie">${mia ? esc(mia.nombre) : T("m_wg_pena_sumate")}</span>
        <span class="wg-sub">${mia ? "#" + mia.ranking + " · " + mia.altas + " " + T(mia.altas === 1 ? "m_pena_hincha" : "m_pena_hinchas") : T("m_wg_pena_p")}</span>
      </button>`);
    }
    w.push(`<button type="button" class="wg wg-negro" data-goto="carnet" aria-label="${T("tab_carnet")}">
      ${OLI.ic("qr", 34)}
      <span class="wg-t wg-pie" style="color:#fff">${T("tab_carnet")}</span>
      <span class="wg-sub" style="color:#a8a6a1">${esc(nivel || "")}</span>
      <span class="wg-fr" aria-hidden="true"></span>
    </button>`);
    return w.join("");
  }
  // Misma tarjeta de producto que el banner de la landing (mismas clases .destacado*).
  function destacadoSubasta(subaViva) {
    return `<div class="destacado" data-goto="descubrir" data-seg="subastas" style="cursor:pointer">
      <div class="destacado-media">${subastaMedia(subaViva)}
        <span class="destacado-live"><span class="destacado-dot"></span>${T("m_sub_envivo")}</span>
        <span class="destacado-clock">${icon("hourglass", { size: 14 })} ${cdTexto(subaViva.termina).txt}</span></div>
      <div class="destacado-info">
        <span class="destacado-tag">${T("tab_subastas")}</span>
        <h3 class="destacado-titulo">${esc(subaViva.titulo)}</h3>
        <div class="destacado-precio-row">
          <div class="destacado-precio"><span class="destacado-precio-lbl">${T("m_sub_actual")}</span><strong>${gs(subaViva.puja_actual)}</strong><span class="precio-usd">${gsUsdRef(subaViva.puja_actual)}</span></div>
          <span class="destacado-pujadores">${icon("users", { size: 14 })} ${subaViva.pujadores} ${T("m_sub_pujando")}</span></div>
        <span class="destacado-cta">${T("m_sub_pujar")} →</span>
      </div>
    </div>`;
  }
  function destacadoSorteo(sor) {
    return `<div class="destacado" data-goto="descubrir" data-seg="sorteos" style="cursor:pointer">
      <div class="destacado-media">${artSvg(sor.id, sor.titulo, icon("gift", { size: 34 }))}
        <span class="destacado-clock">${icon("hourglass", { size: 14 })} ${T("m_cierra")} ${sor.cierra}</span></div>
      <div class="destacado-info">
        <span class="destacado-tag">${T("tab_sorteos")}</span>
        <h3 class="destacado-titulo">${esc(sor.titulo)}</h3>
        <span class="destacado-cta">${sor.participando ? T("m_ya_participas") : T("m_participar")} →</span>
      </div>
    </div>`;
  }
  function escalonCard() {
    if (esSocioValidado()) return ""; // ya validado — no hay nada más que ofrecerle acá
    const tier = (SESSION.membresia && SESSION.membresia.tier_slug) || "olimpista";
    // Socio NO se compra (se otorga al validar la cédula) — para un Plus sin validar,
    // el "próximo escalón" real es la validación gratis, no un botón de compra que
    // el backend siempre rechaza con 403.
    const target = tier === "premium" ? "socio" : "premium";
    const texto = target === "socio"
      ? `<strong>${T("up_card_h")}</strong> — ${T("up_card_p")}`
      : `<strong>${T("m_ini_escalon_h")}</strong> — ${T("m_ini_escalon_p")}`;
    const cta = target === "socio" ? T("ob_validar") : T("m_ini_escalon_cta");
    return `<div class="socio-banner" id="iniEscalon" data-tier="${target}" style="cursor:pointer;margin-top:24px">
      <span class="sb-txt">${icon("trophy", { size: 16 })} ${texto}</span>
      <button class="btn btn-valor btn-sm">${cta}</button></div>`;
  }

  // ─── Encuestas (Fan Survey): card en Inicio ───
  function encuestaCard(e) {
    return `<div class="enc-card"><span class="enc-eyebrow">${icon("info", { size: 12 })} ${T("m_enc_eyebrow")}</span>
      <strong class="enc-q">${esc(e.pregunta)}</strong>
      <div class="enc-body">${e.respondida ? encuestaResultados(e.resultados, e.mi_opcion) : encuestaInputs(e)}</div></div>`;
  }
  function encuestaInputs(e) {
    if (e.tipo === "texto")
      return `<textarea class="enc-ta" id="encTa" rows="2" maxlength="500" placeholder="${T("m_enc_ph")}"></textarea><button class="btn btn-sm" id="encSend">${T("m_enc_enviar")}</button>`;
    return `<div class="enc-ops">${(e.opciones || []).map((op, i) => `<button class="enc-op" data-op="${i}">${esc(op)}</button>`).join("")}</div>`;
  }
  function encuestaResultados(r, miOp) {
    if (!r) return `<p class="enc-gracias">${T("m_enc_gracias")}</p>`;
    if (r.tipo === "texto") return `<p class="enc-gracias">${icon("check", { size: 14 })} ${T("m_enc_gracias")}</p>`;
    const total = r.total || 0;
    const rows = (r.conteo || []).map((c) => {
      const pct = total ? Math.round((c.n / total) * 100) : 0;
      return `<div class="enc-res${c.i === Number(miOp) ? " mine" : ""}"><div class="enc-res-bar" style="width:${pct}%"></div>
        <span class="enc-res-l">${esc(c.opcion)}${c.i === Number(miOp) ? " " + icon("check", { size: 12 }) : ""}</span><span class="enc-res-p">${pct}%</span></div>`;
    }).join("");
    return `<div class="enc-results">${rows}</div><p class="enc-total">${total} ${T("m_enc_votos")} · ${T("m_enc_gracias")}</p>`;
  }
  function bindEncuesta(card, e) {
    const finish = (resultados, miOp) => {
      const body = card.querySelector(".enc-body");
      if (body) body.innerHTML = encuestaResultados(resultados, miOp);
      if (window.OLI && OLI.track) OLI.track("Encuesta");
    };
    card.querySelectorAll(".enc-op").forEach((b) => b.addEventListener("click", async () => {
      const op = Number(b.dataset.op);
      card.querySelectorAll(".enc-op").forEach((x) => (x.disabled = true));
      try { const r = await api("/encuestas/" + e.id + "/responder", { method: "POST", body: { opcion: op } }); finish(r.resultados, op); }
      catch (err) { toast(err.message); card.querySelectorAll(".enc-op").forEach((x) => (x.disabled = false)); }
    }));
    const send = card.querySelector("#encSend");
    if (send) send.addEventListener("click", async () => {
      const ta = card.querySelector("#encTa"), texto = ((ta && ta.value) || "").trim();
      if (!texto) { toast(T("m_enc_ph")); return; }
      send.disabled = true;
      try { const r = await api("/encuestas/" + e.id + "/responder", { method: "POST", body: { texto } }); finish(r.resultados, null); }
      catch (err) { toast(err.message); send.disabled = false; }
    });
  }
  function iniNov(ic, tag, titulo, seg, goto) {
    return `<div class="ini-nov" data-goto="${goto || "descubrir"}" data-seg="${seg || ""}">
      <span class="ini-nov-ic">${ic}</span>
      <div class="ini-nov-tx"><span class="ini-nov-tag">${tag}</span><strong>${esc(titulo || "")}</strong></div>
      <span class="ini-nov-go">›</span></div>`;
  }
  // Fila con acción propia (no navega a un tab) — ej. compartir/invitar.
  function iniNovAccion(ic, tag, titulo, id) {
    return `<div class="ini-nov" id="${id}" style="cursor:pointer">
      <span class="ini-nov-ic">${ic}</span>
      <div class="ini-nov-tx"><span class="ini-nov-tag">${tag}</span><strong>${esc(titulo || "")}</strong></div>
      <span class="ini-nov-go">›</span></div>`;
  }

  // ─── Descubrir (hub): subastas / sorteos / preventas / media en un segmentado ──
  let descSeg = "subastas", _deepSub = null;
  function vDescubrir() {
    stopSub();
    const segs = [["subastas", T("tab_subastas")], ["sorteos", T("tab_sorteos")], ["preventas", T("tab_preventas")], ["media", T("tab_media")], ["penas", T("tab_penas")]];
    view().innerHTML = `<div class="section" style="border:none;padding-top:8px">
      <h2>${T("m_desc_h")}</h2><p class="lead">${T("m_desc_p")}</p>
      <div class="seg-nav" id="descSegNav">${segs.map(([id, l]) => `<button class="seg-b${id === descSeg ? " on" : ""}" data-seg="${id}">${l}</button>`).join("")}</div>
      <div id="descHost"></div></div>`;
    view().querySelector("#descSegNav").addEventListener("click", (e) => { const b = e.target.closest("[data-seg]"); if (!b) return; descSeg = b.dataset.seg; curSubId = null; syncUrl(); renderDescSeg(); });
    renderDescSeg();
  }
  function renderDescSeg() {
    window.scrollTo(0, 0); // cambiar de segmento (Subastas/Sorteos/...) también debe volver arriba
    stopSub();
    _contentHost = document.getElementById("descHost");
    const nav = document.getElementById("descSegNav");
    if (nav) nav.querySelectorAll("[data-seg]").forEach((b) => b.classList.toggle("on", b.dataset.seg === descSeg));
    if (descSeg === "subastas" && _deepSub) { const id = _deepSub; _deepSub = null; curSubId = id; syncUrl(true); return vSubastaDetalle(id); }
    ({ subastas: vSubastas, sorteos: vSorteos, preventas: vPreventas, media: vContenido, penas: vPenas }[descSeg] || vSubastas)();
  }

  // ── Upgrade de socio (validación de cédula) — disponible en todo el portal ──
  function esSocioValidado() { return !!(SESSION && SESSION.socio && SESSION.socio.es_socio_olimpia); }
  async function renderBannerSocio() {
    let host = document.getElementById("socioBanner");
    if (!host) {
      host = document.createElement("div"); host.id = "socioBanner";
      const vista = view();
      if (vista && vista.parentNode) vista.parentNode.insertBefore(host, vista);
    }
    // Prioridad 1: ganaste una subasta y falta pagar. Es la única alerta con plata real
    // de por medio — se ve en CUALQUIER pestaña, no solo si entrás a Subastas a mirar.
    try {
      const { items } = await api("/subastas");
      const pendiente = (items || []).find((x) => x.gano && x.pago_estado !== "pagado");
      if (pendiente) {
        host.innerHTML = `<div class="socio-banner socio-banner-pago">
          <span class="sb-txt">${icon("trophy", { size: 16 })} ${T("m_sub_banner_pago")} <b>${esc(pendiente.titulo)}</b>${pendiente.pago_vence ? `<br>${plazoPagoHtml(pendiente.pago_vence, pendiente.ronda)}` : ""}</span>
          <button class="btn btn-valor btn-sm" id="pagoBannerBtn">${T("m_sub_pagar")}</button></div>`;
        host.querySelector("#pagoBannerBtn").onclick = () => { descSeg = "subastas"; activar("descubrir"); };
        return;
      }
    } catch (e) {}
    let off = false; try { off = sessionStorage.getItem("oli_socio_banner") === "1"; } catch (e) {}
    if (esSocioValidado() || off) { host.innerHTML = ""; return; }
    host.innerHTML = `<div class="socio-banner">
      <span class="sb-txt">${icon("trophy", { size: 16 })} ${T("up_banner")}</span>
      <button class="btn btn-sm" id="upBannerBtn">${T("up_cta")}</button>
      <button class="up-x" id="upBannerX" aria-label="Cerrar">${icon("x", { size: 16 })}</button></div>`;
    host.querySelector("#upBannerBtn").onclick = validarSocioModal;
    host.querySelector("#upBannerX").onclick = () => { try { sessionStorage.setItem("oli_socio_banner", "1"); } catch (e) {} host.innerHTML = ""; };
  }
  function validarSocioModal() {
    if (esSocioValidado()) { toast(T("up_ya")); return; }
    const faltaFecha = !SESSION.socio.fecha_nacimiento; // si no tiene fecha, la pedimos acá mismo
    const hoy = new Date().toISOString().slice(0, 10);
    const { root, close: cerrar } = OLI.modal(`
      <h3>${T("up_modal_h")}</h3>
      <p class="muted">${T("up_modal_p")}</p>
      <input id="upCedula" type="text" inputmode="numeric" autocomplete="off" placeholder="${T("ob_cedula_ph")}" />
      ${faltaFecha ? `<label style="display:block;color:var(--gris);font-size:13px;margin-top:10px">${T("ob_fechanac")}</label><input id="upFecha" type="date" max="${hoy}" />` : ""}
      <p class="err" id="upErr"></p>
      <button class="btn btn-block" id="upValidar">${T("ob_validar")}</button>
      <button class="btn btn-ghost btn-block" id="upCerrar" style="margin-top:8px">${T("up_cerrar")}</button>`);
    root.querySelector("#upCerrar").onclick = cerrar;
    root.querySelector("#upValidar").onclick = async () => {
      const cedula = (root.querySelector("#upCedula").value || "").trim();
      const err = root.querySelector("#upErr"); err.textContent = "";
      if (!cedula) { err.textContent = T("ob_cedula_err"); return; }
      const btn = root.querySelector("#upValidar"); btn.disabled = true;
      try {
        // Si falta la fecha de nacimiento, la guardamos primero (la pide para el tier por edad).
        if (faltaFecha) {
          const f = (root.querySelector("#upFecha").value || "").trim();
          if (!f) { err.textContent = T("ob_fechanac_err"); btn.disabled = false; return; }
          await api("/perfil", { method: "PATCH", body: { fecha_nacimiento: f } });
        }
        const r = await api("/perfil/validar-socio", { method: "POST", body: { cedula } });
        cerrar();
        if (r.validado) { await refrescar(); try { OLI.confetti && OLI.confetti(); } catch (e) {} toast(T("up_ok")); activar("carnet"); }
        else { toast(T("up_revision")); }
      } catch (e) { err.textContent = e.message; btn.disabled = false; }
    };
  }

  // Header premium: avatar + saludo + chip de nivel.
  const TIER_LBL = { olimpista: "Olimpista", kids: "Junior", premium: "Plus", socio: "Socio" };
  function renderHeader() {
    const s = SESSION.socio;
    const slug = (SESSION.membresia && SESSION.membresia.tier_slug) || "olimpista";
    const inicial = (s.nombre || s.email || "?").trim().charAt(0).toUpperCase();
    const av = s.foto ? `<img src="${s.foto}" alt="" />` : `<span>${inicial}</span>`;
    const mAv = document.getElementById("mAv"); if (mAv) mAv.innerHTML = av;
    const su = document.getElementById("sideUser");
    if (su) su.innerHTML = `<span class="side-av">${av}</span><span class="side-ut"><b>${esc([s.nombre, s.apellido].filter(Boolean).join(" ") || s.email)}</b><small>${TIER_LBL[slug] ? (LANG === "en" ? "Olimpista " : "Olimpista ") + TIER_LBL[slug] : "Olimpista"}</small></span>`;
    const me = document.getElementById("me");
    if (me) me.innerHTML = `
      <div class="me-av">${av}</div>
      <div class="me-txt"><span class="me-hi">${T("m_hola")}</span><strong id="hola">${esc(s.nombre || s.email)}</strong></div>
      <span class="tier-chip tier-chip--${slug}">${TIER_LBL[slug] || "Olimpista"}</span>`;
  }

  // ─── Encabezado móvil: título de la pestaña (lo toma de la vista), colapso con el scroll y menú del avatar ───
  function syncHead() {
    const t = document.getElementById("mTitle"), sub = document.getElementById("mSub");
    if (!t) return;
    const h = view().querySelector("h2.ini-hi, .section > h2");
    const lead = h && h.nextElementSibling && h.nextElementSibling.classList.contains("lead") ? h.nextElementSibling : null;
    const txt = (h && h.textContent.trim()) || T("tab_" + curTab);
    if (t.textContent !== txt) t.textContent = txt;
    const st = lead ? lead.textContent.trim() : "";
    if (sub.textContent !== st) sub.textContent = st;
  }
  function initEncabezadoMovil() {
    const head = document.getElementById("mHead");
    if (!head) return;
    let raf = 0;
    const quieto = window.matchMedia("(prefers-reduced-motion: reduce)"), escritorio = window.matchMedia("(min-width: 901px)");
    const onScroll = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0;
      // Escritorio: encabezado fijo, sin colapso. Con movimiento reducido: sin interpolación, compacto al pasar de 60 px.
      const c = escritorio.matches ? 0 : quieto.matches ? (window.scrollY > 60 ? 1 : 0) : Math.min(1, Math.max(0, window.scrollY / 120));
      head.style.setProperty("--c", c.toFixed(3)); }); };
    if (escritorio.addEventListener) escritorio.addEventListener("change", onScroll);
    window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
    let pend = 0;
    new MutationObserver(() => { if (pend) return; pend = requestAnimationFrame(() => { pend = 0; syncHead(); }); }).observe(view(), { childList: true, subtree: true });
    syncHead();
    document.getElementById("mAv").addEventListener("click", abrirMenuCuenta);
    const su = document.getElementById("sideUser"); if (su) su.addEventListener("click", abrirMenuCuenta);
  }
  // Apariencia en la barra lateral (escritorio): mismo control que en Ajustes.
  function segTema(pref) {
    return [["auto", T("m_tema_auto")], ["claro", T("m_tema_claro")], ["oscuro", T("m_tema_oscuro")]].map(([v, l]) =>
      `<button type="button" role="radio" class="ctl-seg-b" data-tema="${v}" aria-checked="${pref === v}">${l}</button>`).join("");
  }
  function prefActual() { const p = window.OLITheme ? OLITheme.pref() : "auto"; return p === "light" ? "claro" : p === "dark" ? "oscuro" : "auto"; }
  function pintarSideTema() {
    const el = document.getElementById("sideTema"); if (!el) return;
    el.innerHTML = segTema(prefActual());
    el.querySelectorAll("[data-tema]").forEach((b) => b.onclick = () => OLI.setThemePref(b.dataset.tema, true));
  }
  const sw = (id, on) => `<button type="button" role="switch" class="interruptor" id="${id}" aria-checked="${on}"></button>`;
  const cuadro = (color, ic) => `<span class="grupo-ic" style="background:${color}"><svg class="ic" width="18" height="18"><use href="/assets/icons.svg#i-${ic}"/></svg></span>`;
  const chev = '<svg class="ic grupo-chev"><use href="/assets/icons.svg#i-chevron-derecha"/></svg>';
  function abrirMenuCuenta() {
    const s = SESSION.socio, slug = (SESSION.membresia && SESSION.membresia.tier_slug) || "olimpista";
    const inicial = (s.nombre || s.email || "?").trim().charAt(0).toUpperCase();
    const av = s.foto ? `<img src="${s.foto}" alt="" />` : `<span>${inicial}</span>`;
    const lang = window.OLI_I18N ? OLI_I18N.lang() : "es";
    const avisos = [["avisos_subastas", T("m_avisos_subastas")], ["avisos_sorteos", T("m_avisos_sorteos")], ["avisos_contenido", T("m_avisos_contenido")]];
    const { root, close } = OLI.modal(`
      <div class="aj-user"><div class="aj-av">${av}</div><div class="aj-id"><strong>${esc([s.nombre, s.apellido].filter(Boolean).join(" ") || s.email)}</strong><span>Olimpista ${TIER_LBL[slug] || ""} · ${esc(s.email)}</span></div></div>
      <div class="grupo-h">${T("m_aj_cuenta")}</div>
      <div class="grupo">
        <button type="button" class="grupo-fila" id="ajPerfil">${cuadro("#2F5FD0", "perfil")}<span class="grupo-tx"><b>${T("tab_perfil")}</b></span>${chev}</button>
        <button type="button" class="grupo-fila" id="ajPena">${cuadro("#C2410C", "pena")}<span class="grupo-tx"><b>${T("m_wg_pena")}</b></span>${chev}</button>
      </div>
      <div class="grupo-h">${T("m_tema_h")}</div>
      <div class="ctl-seg ctl-seg-full" role="radiogroup" aria-label="${T("m_tema_h")}" id="ajTema">${segTema(prefActual())}</div>
      <div class="grupo-h">${T("m_aj_pref")}</div>
      <div class="grupo">
        <button type="button" class="grupo-fila" id="ajLang">${cuadro("#0E7C86", "idioma")}<span class="grupo-tx"><b>${T("m_idioma")}</b></span><span class="grupo-val">${lang === "en" ? "English" : "Español"}</span></button>
        ${avisos.map(([k, l]) => `<div class="grupo-fila">${cuadro("#D0612F", "avisos")}<span class="grupo-tx"><b>${l}</b></span>${sw("aj_" + k, s[k] !== false)}</div>`).join("")}
      </div>
      <div class="grupo-h">${T("m_aj_ayuda")}</div>
      <div class="grupo">
        <a class="grupo-fila" href="/ayuda" target="_blank" rel="noopener">${cuadro("#5E5E66", "ayuda")}<span class="grupo-tx"><b>${T("m_ayuda")}</b></span>${chev}</a>
        <button type="button" class="grupo-fila aj-salir" id="ajSalir">${cuadro("#B3261E", "salir")}<span class="grupo-tx"><b>${T("m_cerrar_sesion")}</b></span></button>
      </div>`);
    root.classList.add("aj");
    root.querySelector("#ajPerfil").onclick = () => { close(); activar("perfil"); };
    root.querySelector("#ajPena").onclick = () => { close(); descSeg = "penas"; activar("descubrir"); };
    root.querySelector("#ajLang").onclick = () => { OLI_I18N.setLang(lang === "en" ? "es" : "en"); location.reload(); };
    root.querySelectorAll("#ajTema [data-tema]").forEach((b) => b.onclick = () => {
      OLI.setThemePref(b.dataset.tema, true);
      root.querySelectorAll("#ajTema [data-tema]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    });
    avisos.forEach(([k]) => { const el = root.querySelector("#aj_" + k); el.onclick = async () => {
      const on = el.getAttribute("aria-checked") !== "true"; el.setAttribute("aria-checked", String(on));
      try { const r = await api("/perfil", { method: "PATCH", body: { [k]: on } }); SESSION.socio = r.socio; }
      catch (e) { el.setAttribute("aria-checked", String(!on)); toast(e.message); }
    }; });
    root.querySelector("#ajSalir").onclick = () => { close(); logout(); };
  }

  const hap = () => { try { navigator.vibrate && navigator.vibrate(10); } catch (e) {} };

  // ─── Tirar para actualizar (Inicio y Subastas): hasta 70 px de arrastre con resistencia .5, spinner de franjas; recarga los datos de la vista, no la página ───
  function initTirarParaActualizar() {
    const ind = document.createElement("div"); ind.className = "ptr"; ind.setAttribute("aria-hidden", "true"); ind.innerHTML = "<span></span>";
    document.body.appendChild(ind);
    let y0 = null, dist = 0, cargando = false;
    const habilitado = () => curTab === "inicio" || (curTab === "descubrir" && descSeg === "subastas" && !curSubId);
    document.addEventListener("touchstart", (e) => { y0 = (window.scrollY <= 0 && habilitado() && !cargando && e.touches.length === 1) ? e.touches[0].clientY : null; dist = 0; }, { passive: true });
    document.addEventListener("touchmove", (e) => {
      if (y0 == null) return;
      dist = Math.max(0, Math.min(70, (e.touches[0].clientY - y0) * 0.5));
      if (dist > 0) { ind.style.opacity = String(Math.min(1, dist / 40)); ind.style.transform = "translate(-50%," + dist + "px)"; }
    }, { passive: true });
    document.addEventListener("touchend", async () => {
      if (y0 == null) return; y0 = null;
      if (dist >= 60 && !cargando) {
        cargando = true; ind.classList.add("on"); hap();
        try { SESSION = (await yo()) || SESSION; renderHeader(); await activar(curTab, { fromRoute: true }); } catch (e) {}
        await new Promise((r) => setTimeout(r, 400)); ind.classList.remove("on"); cargando = false;
      }
      ind.style.opacity = "0"; ind.style.transform = "translate(-50%,0)";
    }, { passive: true });
  }

  // ─── Partidos: próximo partido, abono (según Tuti) y "No voy · liberar mi lugar". Detrás de TUTI_TICKETERA: mientras Tuti
  // no exponga los endpoints, la pestaña explica qué viene y no inventa partidos ni asientos. ───
  async function vPartidos() {
    const cfg = CONFIG && CONFIG.ticketera ? CONFIG.ticketera : { activa: false, url: "" };
    const reg = await api("/puntos").then((p) => (p.reglas || []).find((r) => r.clave === "liberar")).catch(() => null);
    const pts = reg && reg.puntos ? "+" + reg.puntos : "";
    const chev = icon("chevron-right", { size: 14 });
    const fila = (color, ic, titulo, sub, extra) => `<div class="grupo-fila"><span class="grupo-ic" style="background:${color}">${OLI.ic(ic, 18)}</span><span class="grupo-tx"><b>${titulo}</b>${sub ? `<small>${sub}</small>` : ""}</span>${extra || ""}</div>`;
    view().innerHTML = `<div class="section" style="border:none;padding-top:8px">
      <h2>${T("tab_partidos")}</h2><p class="lead">${T("m_pt_sub")}</p>
      <div class="pt-grid">
        <div class="pt-card"><div class="pt-card-in"><span class="pt-eb">${T("m_pt_eb")}</span>
          <div class="pt-titulo">${T("m_pt_conectando")}</div>
          <p class="pt-txt">${T("m_pt_txt")}</p></div><div class="pt-fr" aria-hidden="true"></div></div>
        <div class="pt-col">
          <div class="grupo">
            ${fila("#1F4A7A", "liberar", T("m_pt_abono"), T("m_pt_abono_sub"), `<span class="grupo-val">${T("m_pt_pronto")}</span>`)}
            ${fila("#B3261E", "candado", T("m_pt_liberar"), pts ? pts + " " + T("m_pt_puntos") : "", `<span class="grupo-val">${T("m_pt_pronto")}</span>`)}
          </div>
          <p class="pt-nota">${T("m_pt_nota")}</p>
          ${cfg.url ? `<a class="btn btn-block" href="${esc(cfg.url)}" target="_blank" rel="noopener">${T("m_pt_comprar")}</a>` : ""}
        </div>
      </div></div>`;
    void chev;
  }

  // ─── Anillo de progreso (persistente, animado) ───────────────────────────────
  function renderProgreso() {
    const cont = document.getElementById("progreso");
    if (!cont) return; // solo existe montado dentro de "mis cosas" en Inicio
    const p = SESSION.progreso;
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
    const el = document.getElementById("f_" + key);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => el.click(), 250); // deja terminar el scroll antes de abrir edición/modal
  }

  // ─── Mi perfil ───────────────────────────────────────────────────────────────
  // Campos editables en línea (F2): cada uno se toca, se edita y se guarda solo —
  // nada de formulario grande con un botón "Guardar" al final.
  function nombrePais(iso) { return ((CONFIG && CONFIG.paises) || []).find((p) => p.iso === iso)?.nombre || ""; }
  function vPerfil() {
    const s = SESSION.socio;
    const avatar = s.foto ? `<img class="avatar" id="avatar" src="${s.foto}" alt="" />` : `<div class="avatar" id="avatar">${icon("camera", { size: 40 })}</div>`;
    const tienePunto = perfilPunto.lat != null;
    const campos = [
      { key: "nombre", label: T("m_nombre"), type: "text", value: s.nombre },
      { key: "apellido", label: T("m_apellido"), type: "text", value: s.apellido },
      { key: "whatsapp", label: T("m_whatsapp"), type: "text", value: s.whatsapp, placeholder: "+595 9xx xxx xxx" },
      { key: "pais_iso", label: T("m_pais"), type: "select", value: s.pais_iso, display: nombrePais(s.pais_iso) },
      { key: "ciudad", label: T("m_ciudad"), type: "text", value: s.ciudad },
      { key: "fecha_nacimiento", label: T("ob_fechanac"), type: "date", value: String(s.fecha_nacimiento || "").slice(0, 10), display: s.fecha_nacimiento ? fecha(s.fecha_nacimiento) : "" },
    ];
    const filaCampo = (c) => `<div class="pf-campo" data-key="${c.key}">
      <span class="pf-lbl">${c.label}</span>
      <button type="button" class="pf-val" id="f_${c.key}"><span>${esc(String((c.display != null ? c.display : c.value) || "—"))}</span>${icon("pencil", { size: 13 })}</button>
    </div>`;
    const avisos = [
      { key: "avisos_subastas", label: T("m_avisos_subastas"), on: s.avisos_subastas !== false },
      { key: "avisos_sorteos", label: T("m_avisos_sorteos"), on: s.avisos_sorteos !== false },
      { key: "avisos_contenido", label: T("m_avisos_contenido"), on: s.avisos_contenido !== false },
    ];
    const tierSlug = (SESSION.membresia && SESSION.membresia.tier_slug) || "olimpista";
    const tierInfo = ((CONFIG && CONFIG.tiers) || []).find((t) => t.slug === tierSlug);
    const puedeCancelar = tierSlug !== "olimpista" && tierInfo && tierInfo.comprable !== false;
    view().innerHTML = `
      <div class="section" style="border:none;padding-top:8px">
        <h2>${T("m_perfil_h")}</h2>
        <p class="lead">${T("m_perfil_p")}</p>
        <div class="perfil-grid">
          <div class="perfil-datos">
            <div class="foto-up">
              ${avatar}
              <button type="button" class="foto-btn" id="f_foto">${icon("camera", { size: 14 })} ${T("m_foto_cambiar")}</button>
            </div>
            <div class="grupo pf-list sin-ic">
              ${campos.map(filaCampo).join("")}
              <div class="pf-campo pf-readonly"><span class="pf-lbl">${T("m_email")}</span><span class="pf-val">${esc(s.email)}</span></div>
            </div>
          </div>

          <div class="perfil-casa">
            <h3 style="margin:0 0 4px">${T("m_casa_h")}</h3>
            <p class="lead" style="margin-bottom:12px">${T("m_casa_p")}</p>
            <div class="ubic" style="margin-top:12px">
              <button class="btn btn-ghost" id="btnGeo" type="button">${T("m_geo")}</button>
              <button class="btn" id="btnCasa" type="button">${T("m_casa_boton")}</button>
              <span id="ubicEstado" class="muted">${tienePunto ? T("m_fijado") : T("m_sin_fijar")}</span>
            </div>
            <div id="perfilMapa" class="ob-mapa"><div class="ob-mapa-pin">${icon("map-pin", { size: 28 })}</div></div>
            <p class="ob-mapa-hint">${T("m_casa_toca")}</p>
          </div>
        </div>

        ${puedeCancelar ? `<div class="perfil-cancelar"><button type="button" class="pf-cancel-link" id="btnCancelarMembresia">${T("m_cancelar_membresia")}</button></div>` : ""}
      </div>`;
    document.getElementById("f_foto").onclick = () => fotoModal(subirFoto);
    document.getElementById("btnGeo").onclick = usarUbicacion;
    campos.forEach((c) => { document.getElementById("f_" + c.key).onclick = () => entrarEdicionPerfil(c); });
    const cancelBtn = document.getElementById("btnCancelarMembresia");
    if (cancelBtn) cancelBtn.onclick = () => confirmarCancelarMembresia(cancelBtn);
    document.getElementById("btnCasa").onclick = abrirHojaCasa;
    initPerfilMapa();
    if (!s.pais_iso) prefillPaisPorIP();
  }
  function entrarEdicionPerfil(c) {
    const btn = document.getElementById("f_" + c.key);
    const wrap = btn.closest(".pf-campo");
    let inputHtml;
    if (c.type === "select") {
      const opts = `<option value="">${T("m_elegi_pais")}</option>` +
        (CONFIG.paises || []).map((p) => `<option value="${p.iso}" ${p.iso === c.value ? "selected" : ""}>${esc(p.nombre)}</option>`).join("");
      inputHtml = `<select id="pfInput">${opts}</select>`;
    } else if (c.type === "date") {
      inputHtml = `<input id="pfInput" type="date" max="${new Date().toISOString().slice(0, 10)}" value="${attr(c.value)}" />`;
    } else {
      inputHtml = `<input id="pfInput" type="text" value="${attr(c.value)}" placeholder="${attr(c.placeholder || "")}" />`;
    }
    wrap.innerHTML = `<span class="pf-lbl">${c.label}</span>
      <div class="pf-edit">${inputHtml}<button type="button" class="btn btn-sm" id="pfOk">${icon("check", { size: 14 })}</button></div>`;
    const input = document.getElementById("pfInput");
    input.focus();
    const commit = () => {
      const apiKey = c.key === "pais_iso" ? "pais" : c.key;
      guardarCampoPerfil({ [apiKey]: input.value }, T("m_perfil_ok"));
    };
    document.getElementById("pfOk").onclick = commit;
    if (c.type === "select") input.addEventListener("change", commit);
    else input.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") vPerfil(); });
  }
  async function guardarCampoPerfil(body, msgOk) {
    try {
      const r = await api("/perfil", { method: "PATCH", body });
      SESSION.socio = r.socio; SESSION.progreso = r.progreso;
      renderHeader();
      toast(msgOk);
    } catch (e) { toast(e.message); }
    finally { vPerfil(); } // re-render completo: simple y evita que el DOM y SESSION diverjan
  }
  async function guardarAviso(key, checked) {
    try { const r = await api("/perfil", { method: "PATCH", body: { [key]: checked } }); SESSION.socio = r.socio; }
    catch (e) { toast(e.message); vPerfil(); }
  }
  // Cancelación en 2 toques (F2): un primer toque pide confirmación en el momento
  // (sin encuesta, sin oferta de retención); el segundo la ejecuta. No hay nada
  // recurrente que frenar (el cobro es anual único) — cancelar = volver a Olimpista ya.
  function confirmarCancelarMembresia(btn) {
    const wrap = btn.parentElement;
    wrap.innerHTML = `<p class="pf-cancel-confirm">${T("m_cancelar_confirm")}</p>
      <div class="pf-cancel-acts">
        <button type="button" class="btn btn-ghost btn-sm" id="cancelarNo">${T("m_cancelar_no")}</button>
        <button type="button" class="btn btn-ghost btn-sm" id="cancelarSi">${T("m_cancelar_si")}</button>
      </div>`;
    document.getElementById("cancelarNo").onclick = () => vPerfil();
    document.getElementById("cancelarSi").onclick = async () => {
      try { await api("/membresia/cancelar", { method: "POST" }); await refrescar(); toast(T("m_cancelar_ok")); vPerfil(); }
      catch (e) { toast(e.message); }
    };
  }

  // Solo encuadra el mapa cerca de su país detectado — ya no pre-llena el campo país
  // (con edición inline no hay un "Guardar" global que revise antes de persistir; el
  // socio lo toca y lo confirma él mismo si quiere setearlo).
  async function prefillPaisPorIP() {
    try {
      const { pais } = await api("/geo");
      if (pais && pais.iso && perfilPunto.lat == null && pais.lat != null && perfilGlobo) {
        perfilGlobo.flyTo({ center: [pais.lng, pais.lat], zoom: 6 });
      }
    } catch { /* sin geo */ }
  }

  // Mapa callejero con pin FIJO al centro (mové el mapa → el centro es tu punto).
  const ESTILO_CALLE = {
    version: 8,
    sources: { calles: { type: "raster", tileSize: 256, maxzoom: 19, attribution: "Esri",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"] } },
    layers: [{ id: "calles", type: "raster", source: "calles" }],
  };
  function initPerfilMapa() {
    const arranque = () => {
      const el = document.getElementById("perfilMapa");
      if (!window.maplibregl || !el || !el.isConnected) return;
      if (perfilGlobo) { try { perfilGlobo.remove(); } catch (e) {} perfilGlobo = null; }
      const tiene = perfilPunto.lat != null;
      perfilGlobo = new window.maplibregl.Map({
        container: el, style: ESTILO_CALLE,
        center: tiene ? [perfilPunto.lng, perfilPunto.lat] : [-57.63, -25.29],
        zoom: tiene ? 15 : 11, attributionControl: false,
      });
      perfilGlobo.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "top-right");
      // El pin vive fijo al centro (CSS). Mover el mapa solo propone un punto: NO se guarda hasta
      // tocar "Poner mi bandera acá" (un solo PATCH, con la confirmación de privacidad).
      perfilGlobo.on("moveend", () => { const c = perfilGlobo.getCenter(); perfilPunto = { lat: c.lat, lng: c.lng }; marcarSinGuardar(); });
    };
    OLI.cargarMapa().then(arranque).catch(() => { const e = document.getElementById("ubicEstado"); if (e) e.textContent = T("m_geo_err"); });
  }
  function marcarFijado() { const e = document.getElementById("ubicEstado"); if (e) e.textContent = T("m_fijado"); }
  function marcarSinGuardar() { const e = document.getElementById("ubicEstado"); if (e) e.textContent = T("m_sin_guardar"); }

  // Hoja "Poner mi bandera acá": confirma la privacidad y guarda el punto de una sola vez.
  function abrirHojaCasa() {
    if (perfilPunto.lat == null && perfilGlobo) { const c = perfilGlobo.getCenter(); perfilPunto = { lat: c.lat, lng: c.lng }; }
    if (perfilPunto.lat == null) return toast(T("m_sin_fijar"));
    const s = SESSION.socio;
    const { root, close } = OLI.modal(`<h3>${T("m_casa_boton")}</h3><p class="muted" style="margin:6px 0 14px">${T("m_casa_privacidad")}</p>
      <div class="grupo sin-ic"><div class="grupo-fila"><span class="grupo-tx"><b>${T("m_casa_mostrar")}</b></span>
        <button type="button" role="switch" class="interruptor" id="hcMostrar" aria-checked="${!!s.mostrar_exacto}"></button></div></div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:16px">
        <button type="button" class="btn btn-block" id="hcGuardar">${T("m_casa_guardar")}</button>
        <button type="button" class="btn btn-ghost btn-block" id="hcVer">${T("m_casa_ver")}</button>
      </div>`);
    const sw = root.querySelector("#hcMostrar");
    sw.onclick = () => sw.setAttribute("aria-checked", sw.getAttribute("aria-checked") === "true" ? "false" : "true");
    const guardar = async () => {
      const r = await api("/perfil", { method: "PATCH", body: { lat: perfilPunto.lat, lng: perfilPunto.lng, mostrar_exacto: sw.getAttribute("aria-checked") === "true" } });
      SESSION.socio = r.socio; SESSION.progreso = r.progreso;
    };
    root.querySelector("#hcGuardar").onclick = async () => { try { await guardar(); marcarFijado(); toast(T("m_casa_ok")); close(); } catch (e) { toast(e.message); } };
    root.querySelector("#hcVer").onclick = async () => {
      try { await guardar(); try { sessionStorage.setItem("oli_nuevo", JSON.stringify({ lat: perfilPunto.lat, lng: perfilPunto.lng, iso: s.pais_iso || "" })); } catch (e) {} location.href = "/#mundo"; }
      catch (e) { toast(e.message); }
    };
  }

  function usarUbicacion() {
    if (!navigator.geolocation) return toast(T("m_geo_no"));
    const e = document.getElementById("ubicEstado");
    if (e) e.textContent = T("m_buscando");
    navigator.geolocation.getCurrentPosition(
      (pos) => { const { latitude, longitude } = pos.coords; perfilPunto = { lat: latitude, lng: longitude }; if (perfilGlobo) perfilGlobo.flyTo({ center: [longitude, latitude], zoom: 16 }); marcarSinGuardar(); },
      () => { if (e) e.textContent = T("m_geo_err"); },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  async function subirFoto(dataUrl) {
    if (!dataUrl) return;
    try {
      const r = await api("/perfil/foto", { method: "POST", body: { foto: dataUrl } });
      SESSION.socio.foto = r.foto; SESSION.progreso = r.progreso;
      document.getElementById("avatar").outerHTML = `<img class="avatar" id="avatar" src="${r.foto}" alt="" />`;
      renderHeader(); renderProgreso(); toast(T("m_foto_ok"));
    } catch (err) { toast(err.message); }
  }

  // "Sos uno de X Olimpistas en [tu país]" — prueba social personalizada.
  async function socialPais() {
    try {
      const iso = SESSION.socio.pais_iso; if (!iso) return "";
      const { porPais } = await api("/stats");
      const p = (porPais || []).find((x) => x.iso === iso); if (!p) return "";
      return `<p class="social-pais">${icon("globe", { size: 14 })} ${T("m_social_pre")} <strong>${Number(p.count).toLocaleString(LOC)}</strong> ${T("m_social_in")} ${p.nombre}</p>`;
    } catch { return ""; }
  }
  function cardUpsell(t) {
    const precio = t.precioAnio > 0 ? `${gs(t.precioAnio)} / ${T("m_anio")}` : T("price_gratis");
    const cn = carnetHTML({ tierSlug: t.slug, tierNombre: t.nombre, nombre: "Tu nombre", numero: "OLI-••••••••", qr: _previewQR, iso: SESSION.socio.pais_iso });
    return `<div class="card card-tier">
      <div class="cn-mini">${cn}</div>
      <div class="body"><span class="chip on">${precio}</span><h4>${esc(t.nombre)}</h4>
      <p>${esc(t.beneficios.slice(1, 3).join(" · "))}</p>
      <button class="btn${t.precioAnio > 0 ? " btn-valor" : ""}" data-upsell="${t.slug}">${t.cta}</button></div></div>`;
  }
  async function upgrade(slug, cedula) {
    try {
      const r = await api("/membresia/unirse", { method: "POST", body: { tier: slug, moneda: (window.OLI.currency && window.OLI.currency()) || "PYG", cedula } });
      if (r.falta_cedula) {                                    // Pagopar exige cédula: la pedimos y reintentamos
        const c = await OLI.pedirCedula(T("m_cedula_pago"));
        if (!c) return;
        return upgrade(slug, c);
      }
      if (r.gratis) { await refrescar(); return vMembresia(); }
      window.OLI.track("InicioPago", "InitiateCheckout", { content_name: slug });
      location.href = r.pago.urlPago;
    } catch (e) { toast(e.message); }
  }

  // Momento de upsell: antes de mandar directo a pago, explicamos QUÉ desbloquea y
  // ofrecemos la vía gratis (validar cédula de socio) antes que la paga. Reemplaza el
  // patrón viejo de "candado → compra directa" que no daba contexto ni alternativa.
  function mostrarUpsell(slug, contexto) {
    const tier = ((CONFIG && CONFIG.tiers) || []).find((t) => t.slug === slug) || ((CONFIG && CONFIG.tiers) || []).find((t) => t.slug === "premium");
    if (!tier) { upgrade(slug); return; } // fallback defensivo si no hay catálogo cargado
    const precio = tier.precioAnio > 0 ? `${gs(tier.precioAnio)} / ${T("m_anio")}` : T("price_gratis");
    // El primer beneficio de cada tier de pago es siempre "Todo lo de <nivel anterior>,
    // incluido" (ver config.js) — acá NO lo repetimos: la hoja de nivel muestra solo lo
    // que se SUMA respecto al nivel actual, nunca la tabla completa de beneficios.
    const suma = (tier.beneficios && tier.beneficios.length > 1) ? tier.beneficios.slice(1) : (tier.beneficios || []);
    const { root, close } = OLI.modal(`
      <div style="text-align:center">
        <div style="display:flex;justify-content:center;margin-bottom:8px">${icon("trophy", { size: 34 })}</div>
        <h3>${esc(contexto || T("m_up_generico"))}</h3>
        <span class="chip on" style="margin:10px 0 16px;display:inline-block">${esc(tier.nombre)} · ${precio}</span>
      </div>
      <p class="muted" style="font-size:12.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin:0 0 8px">${T("m_up_suma")}</p>
      <ul class="benefits" style="margin:0 0 20px">${suma.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
      <button class="btn btn-valor btn-block" id="upsGo">${esc(tier.cta || T("m_subi"))}</button>
      ${!esSocioValidado() ? `<div class="up-socio-alt"><p class="muted" style="font-size:13px;margin:14px 0 8px;text-align:center">${T("m_up_ya_socio")}</p>
        <button class="btn btn-ghost btn-block" id="upsSocio">${icon("trophy", { size: 14 })} ${T("m_up_ya_socio_p")}</button></div>` : ""}
    `);
    root.querySelector("#upsGo").onclick = () => { close(); upgrade(tier.slug); };
    const socioBtn = root.querySelector("#upsSocio");
    if (socioBtn) socioBtn.onclick = () => { close(); validarSocioModal(); };
  }

  // ─── Olimpia Media+ (próximamente) ───────────────────────────────────────────
  // Todavía NO hay reproductor ni storage de video → NO prometemos playback. Se muestra
  // el catálogo como adelanto con estado "Próximamente" (honesto: no reproduce nada aún).
  async function vContenido() {
    cv().innerHTML = skeleton(3);
    const { items } = await api("/contenido");
    cv().innerHTML = `<div class="section" style="border:none;padding-top:8px">
      <div class="enc-eyebrow" style="margin-bottom:8px">${icon("play", { size: 12 })} Olimpia Media+ · ${T("m_media_pronto")}</div>
      ${items.length ? `<div class="grid-3">${items.map(cardContenido).join("")}</div>` : vacio(T("m_vacio_media"))}</div>`;
  }
  function cardContenido(c) {
    return `<div class="card"><div class="thumb">${artSvg(c.id, c.titulo, icon("play", { size: 30 }))}</div>
      <div class="body"><span class="chip">${esc(c.tipo)} · ${esc(c.duracion || "")}</span>
      <h4>${esc(c.titulo)}</h4><p>${esc(c.descripcion)}</p>
      <button class="btn btn-ghost" disabled>${T("m_media_pronto")}</button></div></div>`;
  }

  // ─── Sorteos ───────────────────────────────────────────────────────────────────
  // ─── Puntos: saldo y escalón, misión de la semana, cómo se ganan, catálogo de canje y movimientos ──
  async function vPuntos() {
    view().innerHTML = skeleton(3);
    let d, pr;
    try { [d, pr] = await Promise.all([api("/puntos"), api("/puntos/premios")]); } catch (e) { view().innerHTML = vacio(T("m_error_generico")); return; }
    const nf = (n) => Number(n || 0).toLocaleString(LOC);
    const esc2 = d.escalon || {};
    const falta = esc2.siguiente ? `${T("m_pts_faltan")} ${nf(esc2.faltan)} ${T("m_pts_para")} ${esc2.siguiente.nombre}` : T("m_pts_top");
    const m = d.mision;
    // Misión de la semana: tarjeta negra con tres respuestas en píldora (04-pantallas); si ya la hizo, una fila de confirmación.
    const misionHtml = !m ? "" : m.respondida
      ? `<div class="pts-hecha">${OLI.ic("check-circulo", 22, true)}<span>${m.respondida.correcta ? T("m_pts_mision_ok") : T("m_pts_mision_no")}</span></div>`
      : `<div class="pts-m"><span class="pts-m-eb">${T("m_pts_mision")} · +${nf(m.puntos)}</span><p class="pts-m-q">${esc(m.pregunta)}</p>
          <div class="pts-m-ops">${m.opciones.map((o, i) => `<button type="button" class="pts-m-op" data-mision="${esc(m.id)}" data-op="${i}">${esc(o)}</button>`).join("")}</div></div>`;
    const fila = (tx, sub, der, off) => `<div class="grupo-fila"${off ? ' style="opacity:.45"' : ""}><span class="grupo-tx"><b>${tx}</b>${sub ? `<small>${sub}</small>` : ""}</span>${der || ""}</div>`;
    const reglasHtml = d.reglas.map((r) => fila(esc(r.titulo), esc(r.fuente) + " · " + T("m_pts_q_" + r.quien) + (r.pendiente ? " · " + T("m_pts_pronto") : ""),
      `<span class="pts-n">${r.activa ? "+" + nf(r.puntos) : "—"}</span>`, !(r.aplica && r.activa))).join("");
    const premiosHtml = pr.items.length ? pr.items.map((p) => {
      const txt = p.proximamente ? T("m_pts_pronto") : p.agotado ? T("m_pts_agotado") : p.puede_canjear ? T("m_pts_canjear") : T("m_pts_faltan") + " " + nf(p.faltan);
      return `<div class="grupo-fila"><span class="grupo-tx"><small class="pts-esc">${esc(String(p.escalon).toUpperCase())} · ${nf(p.costo)} PTS</small><b>${esc(p.titulo)}</b>${p.descripcion ? `<small>${esc(p.descripcion)}</small>` : ""}</span>
        <button type="button" class="pts-canje${p.puede_canjear ? " on" : ""}" data-premio="${esc(p.id)}" ${p.puede_canjear ? "" : "disabled"}>${txt}</button></div>`;
    }).join("") : `<div class="grupo-fila"><span class="grupo-tx"><small>${T("m_pts_sin_premios")}</small></span></div>`;
    const movHtml = d.movimientos.length ? d.movimientos.map((x) => fila(esc(x.detalle || x.motivo), fecha(x.creado),
      `<span class="pts-n${x.puntos < 0 ? " neg" : ""}">${x.puntos > 0 ? "+" : "−"}${nf(Math.abs(x.puntos))}</span>`)).join("") : `<div class="grupo-fila"><span class="grupo-tx"><small>${T("m_pts_sin_mov")}</small></span></div>`;
    view().innerHTML = `<div class="section" style="border:none;padding-top:8px">
      <h2>${T("m_pts_h")}</h2><p class="lead">${T("m_pts_escalon")} ${esc(esc2.nombre || "")} · ${falta}</p>
      <div class="pts-grid">
        <div class="pts-col">
          <div class="pts-resumen"><div class="pts-anillo2" style="--p:${Math.max(0, Math.min(100, Number(esc2.pct) || 0))}">${OLI.ic("puntos", 34, true)}</div>
            <span class="pts-saldo"><b>${nf(d.saldo)}</b><small>${T("m_pts_escalon")} ${esc(esc2.nombre || "")} · ${falta}</small></span></div>
          ${misionHtml}
          <div class="grupo-h">${T("m_pts_como")}</div><div class="grupo sin-ic">${reglasHtml}</div>
        </div>
        <div class="pts-col">
          <div class="grupo-h">${T("m_pts_canje")}</div><div class="grupo sin-ic">${premiosHtml}</div>
          <div class="grupo-h">${T("m_pts_mov")}</div><div class="grupo sin-ic">${movHtml}</div>
          ${d.vencen ? `<p class="pt-nota" style="margin-top:12px">${T("m_pts_vencen")}</p>` : ""}
        </div>
      </div>
    </div>`;
    view().querySelectorAll("[data-mision]").forEach((b) => b.addEventListener("click", async () => {
      view().querySelectorAll("[data-mision]").forEach((x) => { x.disabled = true; });
      try {
        const r = await api("/puntos/mision/" + b.dataset.mision, { method: "POST", body: { opcion: Number(b.dataset.op) } });
        hap();
        toast(r.correcta ? T("m_pts_mision_ok") + " +" + nf(r.puntos) : T("m_pts_mision_no"));
      } catch (e) { toast(e.message); }
      vPuntos();
    }));
    view().querySelectorAll("[data-premio]:not([disabled])").forEach((b) => b.addEventListener("click", () => {
      const p = pr.items.find((x) => x.id === b.dataset.premio); if (!p) return;
      const { root, close } = OLI.modal(`<h3>${esc(p.titulo)}</h3><p class="muted">${T("m_pts_confirma")} <b>${nf(p.costo)}</b> ${T("m_pts_puntos")}. ${T("m_pts_wsp")}</p>
        <button class="btn btn-block" id="ptsOk">${T("m_pts_canjear")}</button><button class="btn btn-ghost btn-block" id="ptsNo" style="margin-top:8px">${T("up_cerrar")}</button>`);
      root.querySelector("#ptsNo").onclick = close;
      root.querySelector("#ptsOk").onclick = async () => {
        root.querySelector("#ptsOk").disabled = true;
        try { await api("/puntos/premios/" + p.id + "/canjear", { method: "POST" }); hap(); close(); toast(T("m_pts_canjeado")); }
        catch (e) { close(); toast(e.message); }
        vPuntos();
      };
    }));
  }

  // ─── Peñas: ranking, sumarse, compartir el link y pedir una peña nueva ───────────
  async function vPenas() {
    cv().innerHTML = skeleton(3);
    let d;
    try { d = await api("/penas"); } catch (e) { cv().innerHTML = vacio(T("m_error_generico")); return; }
    const items = Array.isArray(d.items) ? d.items : [];
    const mia = items.find((p) => p.es_tuya);
    const link = (p) => location.origin + "/?pena=" + encodeURIComponent(p.slug);
    cv().innerHTML = `<div class="section" style="border:none;padding-top:8px">
      <p class="lead">${T("m_pena_p")}</p>
      ${mia ? `<div class="pena-mia"><b>${esc(mia.nombre)}</b><span class="muted"> · ${T("m_pena_tuya")}</span>
        <p class="muted" style="font-size:13px;margin:6px 0 10px">${T("m_pena_link_p")}</p>
        <div class="pena-acc"><button class="btn btn-sm" id="penaCompartir">${T("m_pena_compartir")}</button><button class="btn btn-ghost btn-sm" id="penaDejar">${T("m_pena_dejar")}</button></div></div>` : ""}
      <div class="pena-lista">${items.length ? items.map((p) => `<div class="pena-fila">
          <span class="pena-rk">${p.ranking}</span>
          <div class="pena-nm"><b>${esc(p.nombre)}</b><span class="muted">${esc(p.ciudad || "")} · ${p.altas} ${T(p.altas === 1 ? "m_pena_hincha" : "m_pena_hinchas")}</span></div>
          ${p.es_tuya ? `<span class="chip on">${T("m_pena_tuya_chip")}</span>` : `<button class="btn btn-sm btn-ghost" data-pena="${esc(p.id)}">${T("m_pena_sumarme")}</button>`}
        </div>`).join("") : vacio(T("m_pena_vacio"))}</div>
      <details class="pena-sol"><summary>${T("m_pena_solicitar")}</summary>
        <p class="muted" style="font-size:13px;margin:8px 0">${T("m_pena_sol_p")}</p>
        <form id="penaSolForm" class="pena-form">
          <input name="nombre" placeholder="${T("m_pena_f_nombre")}" maxlength="80" required />
          <input name="ciudad" placeholder="${T("m_pena_f_ciudad")}" maxlength="60" required />
          <input name="presidente" placeholder="${T("m_pena_f_presi")}" maxlength="80" required />
          <input name="contacto" type="email" placeholder="${T("m_pena_f_email")}" maxlength="120" required />
          <button class="btn btn-block" type="submit">${T("m_pena_enviar")}</button>
        </form></details>
    </div>`;
    cv().querySelectorAll("[data-pena]").forEach((b) => b.addEventListener("click", async () => {
      try {
        const r = await api("/perfil", { method: "PATCH", body: { pena_id: b.dataset.pena } });
        if (SESSION && SESSION.socio && r.socio) SESSION.socio.pena_id = r.socio.pena_id;
        toast(T("m_pena_sumada"));
        vPenas();
      } catch (e) { toast(e.message); }
    }));
    const dejar = cv().querySelector("#penaDejar");
    if (dejar) dejar.addEventListener("click", async () => {
      try { const r = await api("/perfil", { method: "PATCH", body: { pena_id: null } }); if (SESSION && SESSION.socio && r.socio) SESSION.socio.pena_id = null; toast(T("m_pena_dejada")); vPenas(); }
      catch (e) { toast(e.message); }
    });
    const comp = cv().querySelector("#penaCompartir");
    if (comp && mia) comp.addEventListener("click", async () => {
      const url = link(mia), txt = T("m_pena_compartir_txt") + " " + mia.nombre;
      try { if (navigator.share) { await navigator.share({ text: txt, url }); return; } } catch (e) { if (e && e.name === "AbortError") return; }
      try { await navigator.clipboard.writeText(url); toast(T("m_pena_link_copiado")); } catch (e) { toast(url); }
    });
    const form = cv().querySelector("#penaSolForm");
    if (form) form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form).entries());
      try { await api("/penas/solicitud", { method: "POST", body: f }); form.reset(); toast(T("m_pena_sol_ok")); form.closest("details").open = false; }
      catch (err) { toast(err.message); }
    });
  }

  async function vSorteos() {
    cv().innerHTML = skeleton(3);
    const { items } = await api("/sorteos");
    // Igual que subastas: "en vivo" arriba (accionable), historial de cerrados con
    // resultado abajo (prueba social — este ya se sorteó, esta persona lo ganó).
    const activos = items.filter((x) => x.estado === "activa");
    const cerrados = items.filter((x) => x.estado === "cerrada");
    cv().innerHTML = `<div class="section" style="border:none;padding-top:8px">
      ${activos.length ? `<div class="grid-3">${activos.map(cardSorteo).join("")}</div>` : (cerrados.length ? "" : vacio(T("m_vacio_sorteos")))}
      ${cerrados.length ? `<h3 class="sub-historial-h">${T("m_sor_historial")}</h3><div class="grid-3">${cerrados.map(cardSorteo).join("")}</div>` : ""}
      </div>`;
    cv().querySelectorAll("[data-sorteo]").forEach((el) => el.addEventListener("click", () => participar(el.dataset.sorteo)));
  }
  function cardSorteo(s) {
    const cerrado = s.estado === "cerrada";
    let btn;
    if (cerrado) btn = s.ganador_nombre ? `<button class="btn btn-ghost" disabled>${icon("trophy", { size: 14 })} ${s.gano ? T("m_sub_vos") : esc(s.ganador_nombre)}</button>` : `<button class="btn btn-ghost" disabled>${T("m_sub_cerrada")}</button>`;
    else if (s.participando) btn = `<button class="btn btn-ghost" disabled>${T("m_ya_participas")}</button>`;
    else if (!s.elegible) btn = `<button class="btn btn-ghost" data-upsell-cta="${esc(s.tier_min || "premium")}" data-upsell-ctx="${esc(T("m_up_ctx_sorteo"))}">${icon("chevron-right", { size: 14 })} ${T("m_desbloquear")}</button>`;
    else btn = `<button class="btn" data-sorteo="${s.id}">${T("m_participar")}</button>`;
    return `<div class="card"><div class="thumb">${artSvg(s.id, s.titulo, icon("gift", { size: 30 }))}</div>
      <div class="body"><span class="chip ${cerrado ? "" : (s.elegible ? "on" : "")}">${cerrado ? T("m_sub_cerrada") : T("m_cierra") + " " + s.cierra}</span>
      <h4>${esc(s.titulo)}</h4><p>${esc(s.descripcion)}</p>${btn}</div></div>`;
  }
  async function participar(id) {
    try { await api("/sorteos/" + id + "/participar", { method: "POST" }); toast(T("m_participando")); vSorteos(); }
    catch (e) { toast(e.message); }
  }

  // ─── Preventas ─────────────────────────────────────────────────────────────────
  async function vPreventas() {
    cv().innerHTML = skeleton(3);
    const { items } = await api("/preventas");
    // Sin preventas reales publicadas → teaser "próximamente" (no prometemos stock que no existe).
    if (!items.length) {
      cv().innerHTML = `<div class="section" style="border:none;padding-top:8px">
        <div class="ben-pronto">
          <div class="ben-pronto-ic">${icon("ticket", { size: 44 })}</div>
          <span class="chip on" style="align-self:center">${T("proximamente")}</span>
          <h2>${T("m_prev_pronto_h")}</h2>
          <p class="lead" style="text-align:center;margin:0 auto">${T("m_prev_pronto_p")}</p>
        </div></div>`;
      return;
    }
    const hoy = new Date().toISOString().slice(0, 10);
    const activas = items.filter((p) => !p.fecha || p.fecha >= hoy);
    const pasadas = items.filter((p) => p.fecha && p.fecha < hoy);
    cv().innerHTML = `<div class="section" style="border:none;padding-top:8px">
      ${activas.length ? `<div class="grid-3">${activas.map(cardPreventa).join("")}</div>` : (pasadas.length ? "" : vacio(T("m_vacio_sorteos")))}
      ${pasadas.length ? `<h3 class="sub-historial-h">${T("m_prev_historial")}</h3><div class="grid-3">${pasadas.map(cardPreventa).join("")}</div>` : ""}
      </div>`;
    cv().querySelectorAll("[data-preventa]").forEach((el) => el.addEventListener("click", () => reservar(el.dataset.preventa)));
  }
  function cardPreventa(p) {
    const hoy = new Date().toISOString().slice(0, 10);
    const pasada = !!(p.fecha && p.fecha < hoy);
    const btn = pasada
      ? `<button class="btn btn-ghost" disabled>${T("m_prev_finalizada")}</button>`
      : p.habilitada
      ? `<button class="btn" data-preventa="${p.id}">${T("m_reservar")} (${gs(p.precio_desde)})</button>`
      : `<button class="btn btn-ghost" data-upsell-cta="${esc(p.tier_min || "premium")}" data-upsell-ctx="${esc(T("m_up_ctx_preventa"))}">${icon("chevron-right", { size: 14 })} ${T("m_desbloquear")}</button>`;
    return `<div class="card"><div class="thumb">${artSvg(p.id, p.evento, icon("ticket", { size: 30 }))}</div>
      <div class="body"><span class="chip ${pasada ? "" : (p.habilitada ? "on" : "")}">${pasada ? T("m_prev_finalizada") : p.fecha + " · " + p.sede}</span>
      <h4>${esc(p.evento)}</h4><p>${T("m_desde")} ${gs(p.precio_desde)} · ${p.stock} ${T("m_en_preventa")}</p>${btn}</div></div>`;
  }
  async function reservar(id) {
    try {
      const r = await api("/preventas/" + id + "/comprar", { method: "POST", body: { cantidad: 1 } });
      if (r.gratis) { toast(T("m_reserva_ok")); return vPreventas(); }   // sin cobro → reserva directa
      window.OLI.track && window.OLI.track("InicioPago", "InitiateCheckout", { content_name: "preventa" });
      location.href = r.pago.urlPago;                                    // con cobro → checkout PAGOPAR
    } catch (e) { toast(e.message); }
  }

  // ─── Red de Beneficios (comercios locales adheridos, por nivel) ──────────────
  function benProximamente() {
    return `<div class="section" style="border:none;padding-top:8px">
      <div class="ben-pronto">
        <div class="ben-pronto-ic">${icon("gift", { size: 44 })}</div>
        <span class="chip on" style="align-self:center">${T("proximamente")}</span>
        <h2>${T("m_ben_pronto_h")}</h2>
        <p class="lead" style="text-align:center;margin:0 auto">${T("m_ben_pronto_p")}</p>
      </div></div>`;
  }
  async function vBeneficios() {
    view().innerHTML = skeleton(3);
    let r = null;
    try { r = await api("/beneficios"); } catch (e) { r = null; }
    const items = (r && r.items) || [];
    if (!items.length) { view().innerHTML = benProximamente(); return; } // aún no lanzada → teaser
    const ah = r.ahorro || { mes: 0, total: 0 }, ciudad = r.ciudad || "";
    const TL = { olimpista: "Olimpista", kids: "Junior", premium: "Plus", socio: "Socio" };
    const paga = r.tier === "premium" ? '<div class="ba-paga">Tu Plus rinde — mirá cuánto te ahorra</div>'
      : r.tier === "socio" ? '<div class="ba-paga">El mejor ahorro, por ser Socio del Decano</div>' : "";
    // Billetera de Ahorro: lo del mes grande, lo del año a la derecha y una nota de uso.
    const anioNum = new Date().toLocaleDateString("en-CA", { timeZone: "America/Asuncion" }).slice(0, 4);
    const notaMes = ah.canjes_mes ? ah.canjes_mes + " " + (ah.canjes_mes === 1 ? T("m_ben_canje_uno") : T("m_ben_canje_n")) : T("m_ben_canje_ninguno");
    const ahorroCard = '<div class="ben-ahorro"><div class="ba-lbl">' + T("m_ben_billetera") + '</div>' +
      '<div class="ba-fila"><div><div class="ba-sub">' + T("m_ben_ahorro_mes") + '</div><div class="ba-monto">' + gs(ah.mes) + '</div></div>' +
      '<div class="ba-anio"><div class="ba-sub">' + T("m_ben_ahorro_anio") + ' ' + anioNum + '</div><div class="ba-monto-s">' + gs(ah.anio != null ? ah.anio : ah.total) + '</div></div></div>' +
      '<div class="ba-nota">' + notaMes + ' · ' + T("m_ben_ahorro_total") + ': <b>' + gs(ah.total) + '</b></div>' + paga + '</div>';
    const cod = r.codigo ? '<div class="ben-codigo">' + T("m_ben_codigo") + ': <b>' + esc(String(r.codigo).toUpperCase()) + '</b></div>' : "";
    const propios = items.filter((x) => x.desbloqueado), bloqueados = items.filter((x) => !x.desbloqueado);
    // Local primero: el comercio de tu ciudad va arriba dentro de cada grupo.
    const esLocal = (x) => (ciudad && String(x.comercio_ciudad || "").toLowerCase() === ciudad.toLowerCase()) ? 1 : 0;
    propios.sort((x, y) => esLocal(y) - esLocal(x));
    const fila = (x, bloqueado) => '<button type="button" class="grupo-fila ben-fila" data-ben="' + esc(x.id) + '">' +
      '<span class="ben-val' + (bloqueado ? " lock" : "") + (String(x.valor || "").length > 5 ? " chico" : "") + '">' + esc(x.valor || "") + '</span>' +
      '<span class="grupo-tx"><b>' + esc(x.comercio_nombre || "") + (esLocal(x) && !bloqueado ? ' <span class="ben-loc">' + T("m_ben_tu_ciudad") + '</span>' : "") + '</b><small>' + esc(x.titulo || "") + ' · ' +
      esc(bloqueado ? (T("m_ben_subi") + " " + (TL[x.nivel_min] || "Plus")) : (x.comercio_ciudad || x.comercio_rubro || "")) + '</small></span>' +
      (bloqueado ? OLI.ic("candado", 20) : OLI.ic("chevron-derecha", 18)).replace('class="ic"', 'class="ic grupo-chev"') + '</button>';
    view().innerHTML = '<div class="section" style="border:none;padding-top:8px">' +
      '<h2>' + T("m_ben_h") + '</h2><p class="lead">' + (ciudad ? T("m_ben_p_local").replace("{ciudad}", esc(ciudad)) : T("m_ben_p")) + '</p>' +
      ahorroCard + cod +
      '<div class="ben-cols">' +
        '<div><div class="grupo-h">' + T("m_ben_para_vos") + '</div>' + (propios.length ? '<div class="grupo">' + propios.map((x) => fila(x, false)).join("") + '</div>' : '<p class="pt-nota">' + T("m_ben_vacio") + '</p>') + '</div>' +
        (bloqueados.length ? '<div><div class="grupo-h">' + T("m_ben_subi_h") + '</div><div class="grupo">' + bloqueados.map((x) => fila(x, true)).join("") + '</div></div>' : "") +
      '</div></div>';
    view().querySelectorAll("[data-ben]").forEach((el) => el.addEventListener("click", () => abrirBeneficio(items.find((x) => x.id === el.dataset.ben), TL)));
  }
  // Hoja con el detalle del beneficio: usarlo (mostrar el QR en caja) o subir de nivel.
  function abrirBeneficio(b, TL) {
    if (!b) return;
    const { root, close } = OLI.modal(`
      <p class="ben-hoja-eb">${esc(b.comercio_nombre || "")}</p>
      <h3 class="ben-hoja-t">${esc(b.valor || "")} · ${esc(b.titulo || "")}</h3>
      <p class="ben-hoja-p">${esc(b.descripcion || "") || (b.desbloqueado ? T("m_ben_hoja_usar") : T("m_ben_hoja_subi").replace("{nivel}", TL[b.nivel_min] || "Plus"))}</p>
      <p class="ben-hoja-p muted">${esc([b.comercio_rubro, b.comercio_ciudad].filter(Boolean).join(" · "))}</p>
      <button type="button" class="btn btn-block" id="benCta">${b.desbloqueado ? T("m_ben_mostrar_qr") : T("m_ben_subi") + " " + (TL[b.nivel_min] || "Plus")}</button>
      <button type="button" class="btn btn-ghost btn-block" id="benCerrar">${T("up_cerrar")}</button>`);
    root.querySelector("#benCerrar").onclick = close;
    root.querySelector("#benCta").onclick = () => { close(); if (b.desbloqueado) activar("carnet"); else if (b.nivel_min === "socio") validarSocioModal(); else mostrarUpsell(b.nivel_min || "premium", T("m_ben_subi") + " " + (TL[b.nivel_min] || "Plus")); };
  }

  // ─── Subastas (puja en vivo por polling; Plus y Socio) ───────────────────────
  let _subPoll = null, _subTick = null, _subData = null, _subGen = 0;
  // _subGen invalida a un pollTick que ya salió a la red: sin esto, si el usuario salía del lote
  // mientras la respuesta estaba en vuelo, ese tick se reprogramaba solo y quedaba un poller
  // "zombie" golpeando la API para siempre (uno más por cada lote que se abría y cerraba).
  function stopSub() { _subGen++; if (_subPoll) clearTimeout(_subPoll); if (_subTick) clearInterval(_subTick); _subPoll = _subTick = null; }
  const gsK = (n) => "₲" + Math.round((Number(n) || 0) / 1000) + "k";
  function cdTexto(termina) {
    const ms = new Date(termina).getTime() - Date.now();
    if (ms <= 0) return { txt: "Cerrada", urg: false, fin: true };
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const txt = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}:${String(ss).padStart(2, "0")}`;
    return { txt, urg: ms < 5 * 60 * 1000, fin: false };
  }

  async function vSubastas() {
    stopSub();
    cv().innerHTML = skeleton(2);
    let items;
    try { ({ items } = await api("/subastas")); } catch (e) { cv().innerHTML = vacio(T("m_error_generico")); return; }
    // Separadas: "en vivo" arriba (lo accionable) y el historial de cerradas abajo,
    // como prueba social (esto ya se subastó, esta persona lo ganó).
    const activas = items.filter((x) => x.estado === "activa");
    const cerradas = items.filter((x) => x.estado === "cerrada");
    cv().innerHTML = `<div class="section" style="border:none;padding-top:8px">
      ${activas.length ? `<div class="grid-3">${activas.map(cardSubasta).join("")}</div>` : (cerradas.length ? "" : vacio(T("m_sub_vacio")))}
      ${cerradas.length ? `<h3 class="sub-historial-h">${T("m_sub_historial")}</h3><div class="grid-3">${cerradas.map(cardSubasta).join("")}</div>` : ""}
      </div>`;
    cv().querySelectorAll("[data-sub]").forEach((el) => el.addEventListener("click", () => { curSubId = el.dataset.sub; syncUrl(); vSubastaDetalle(el.dataset.sub); }));
  }
  // Miniatura/hero de una subasta: la foto real subida en el admin si hay, si no el
  // ícono generado (antes SIEMPRE se ignoraba `s.imagen` acá, la imagen subida nunca se veía).
  function subastaMedia(s) { return (s.imagen_url || s.imagen) ? `<img src="${esc(s.imagen_url || s.imagen)}" alt="" decoding="async" />` : artSvg(s.id, s.titulo, s.emoji || icon("gavel", { size: 34 })); }
  function cardSubasta(s) {
    const cd = cdTexto(s.termina), cerrada = s.estado !== "activa" || cd.fin;
    const cta = !s.desbloqueado
      ? `<button class="btn btn-ghost" data-upsell-cta="${esc(s.nivel_min || "premium")}" data-upsell-ctx="${esc(T("m_up_ctx_subasta"))}">${icon("chevron-right", { size: 14 })} ${T("m_sub_subi")}</button>`
      : cerrada
      ? (s.gano
          ? `<button class="btn${s.pago_estado === "pagado" ? "" : " btn-valor"}">${icon("trophy", { size: 14 })} ${s.pago_estado === "pagado" ? T("m_sub_ganaste") : T("m_sub_pagar")}</button>`
          : `<button class="btn btn-ghost" disabled>${T("m_sub_cerrada")}</button>`)
      : `<button class="btn btn-valor">${T("m_sub_pujar")} ›</button>`;
    return `<div class="card card-sub${s.desbloqueado ? "" : " ben-lock"}"${s.desbloqueado && (!cerrada || s.gano) ? ` data-sub="${s.id}" style="cursor:pointer"` : ""}>
      <div class="thumb sub-thumb">${subastaMedia(s)}
        <span class="sub-unico">${icon("shield-check", { size: 11 })} ${T("m_sub_unico")}</span>
        <span class="sub-cd${cd.urg ? " urg" : ""}">${cerrada ? T("m_sub_cerrada") : icon("hourglass", { size: 12 }) + " " + cd.txt}</span></div>
      <div class="body"><span class="chip ${cerrada ? "" : "on"}">${cerrada ? T("m_sub_finalizada") : T("m_sub_envivo")}</span>
        <h4>${esc(s.titulo)}</h4>
        <p class="sub-actual">${T("m_sub_actual")}<br><strong>${gs(s.puja_actual)}</strong> <span class="precio-usd" style="margin:0">${gsUsdRef(s.puja_actual)}</span></p>
        <p class="muted" style="font-size:12px;margin:0">${icon("users", { size: 14 })} ${s.pujadores} ${T("m_sub_pujando")}</p>
        ${cerrada && s.ganador_nombre ? `<p class="muted" style="font-size:12px;margin:2px 0 0">${icon("trophy", { size: 12 })} ${s.gano ? T("m_sub_vos") : esc(s.ganador_nombre)}</p>` : ""}
        ${cta}</div></div>`;
  }

  async function vSubastaDetalle(id) {
    window.scrollTo(0, 0); // entrar al detalle de un lote es "otra pantalla" — no debe heredar el scroll del listado
    stopSub();
    cv().innerHTML = skeleton(0);
    let r;
    try { r = await api("/subastas/" + id); } catch (e) { cv().innerHTML = vacio(T("m_error_generico")); return; }
    renderDetalle(r);
    _subTick = setInterval(tickCd, 1000);
    // setTimeout que se reprograma solo, con jitter (±500ms), en vez de setInterval fijo:
    // un setInterval de 4000ms exacto hace que todas las pestañas abiertas en el mismo
    // momento (ej: justo después de un mailing o un repost) terminen pujando en el
    // mismo segundo para siempre — picos periódicos sincronizados en vez de carga pareja
    // (se vieron en los logs de la caída del 2026-08-09: ráfagas de 300+ req en 1 minuto).
    const gen = _subGen;
    const pollTick = async () => {
      if (gen !== _subGen) return;
      // Pestaña en segundo plano: no se consulta (nadie lo ve) y se vuelve a mirar más tarde.
      if (!document.hidden) {
        try { const d = await api("/subastas/" + id + "?liviano=1"); if (gen !== _subGen) return; actualizarDetalle(d); } catch (e) {}
      }
      if (gen !== _subGen) return;
      _subPoll = setTimeout(pollTick, document.hidden ? 8000 : 3500 + Math.random() * 1000);
    };
    _subPoll = setTimeout(pollTick, 3500 + Math.random() * 1000);
  }
  function estadoHtml(r, cerrada) {
    if (!r.desbloqueado || cerrada) return "";
    if (r.voyGanando) return `<span class="sub-state win">${icon("trophy", { size: 14 })} ${T("m_sub_ganando")}</span>`;
    if (r.miPuja > 0) return `<span class="sub-state out">${icon("circle-alert", { size: 14 })} ${T("m_sub_superado")}</span>`;
    return "";
  }
  function feedHtml(feed) {
    if (!feed || !feed.length) return `<p class="muted">${T("m_sub_primero")}</p>`;
    return feed.map((f) => {
      const iso = String(f.pais_iso || "").toLowerCase().trim();
      const flag = /^[a-z]{2}$/.test(iso) ? `<img class="sub-fflag" src="/assets/flags/4x3/${iso}.svg" alt="" loading="lazy" />` : "";
      return `<div class="sub-fitem${f.yo ? " yo" : ""}">
      <span class="sub-fav-wrap"><span class="sub-fav">${(f.nombre || "?").charAt(0).toUpperCase()}</span>${flag}</span>
      <span class="sub-fnm">${f.yo ? "Vos" : esc(f.nombre)}</span>
      <span class="sub-fam">${gs(f.monto)}</span></div>`;
    }).join("");
  }
  function accionesHtml(r, cerrada) {
    const s = r.subasta;
    if (!r.desbloqueado) return `<button class="btn btn-block" data-upsell-cta="${esc(s.nivel_min || "premium")}" data-upsell-ctx="${esc(T("m_up_ctx_subasta"))}">${icon("chevron-right", { size: 14 })} ${T("m_sub_subi")}</button>`;
    if (cerrada && r.gano && s.pago_estado !== "pagado") return `<div class="sub-cerrada">${icon("trophy", { size: 14 })} ${T("m_sub_ganaste_txt")}</div>
      ${r.pago_vence ? `<div class="sub-plazo-box">${plazoPagoHtml(r.pago_vence, r.ronda)}</div>` : ""}
      <button class="btn btn-valor btn-block" id="subPagarBtn" data-sub-pagar="${s.id}">${T("m_sub_pagar")} — ${gs(s.puja_actual)}</button>`;
    if (cerrada && r.gano) return `<div class="sub-cerrada">${icon("check", { size: 14 })} ${T("m_sub_pagado_txt")}</div>
      <a class="btn btn-ghost btn-block" href="/subasta/${esc(s.slug || s.id)}/certificado" target="_blank" rel="noopener">${icon("trophy", { size: 14 })} ${T("m_sub_certificado")}</a>`;
    if (cerrada) return `<div class="sub-cerrada">${T("m_sub_cerrada_txt")}</div>`;
    const next = s.puja_actual + s.incremento;
    return `<button class="btn btn-valor btn-block sub-puja" data-monto="${next}">${T("m_sub_pujar")} ${gs(next)}</button>
      <div class="sub-quick">
        <button class="chip-btn sub-puja" data-monto="${s.puja_actual + s.incremento * 2}">+${gsK(s.incremento * 2)}</button>
        <button class="chip-btn sub-puja" data-monto="${s.puja_actual + s.incremento * 5}">+${gsK(s.incremento * 5)}</button>
        <button class="chip-btn sub-puja" data-monto="${s.puja_actual + s.incremento * 10}">+${gsK(s.incremento * 10)}</button>
      </div>
      <a class="sub-custom-toggle" id="subCustomToggle">${T("m_sub_monto_libre")}</a>
      <div class="sub-custom-form" id="subCustomForm" hidden>
        <input type="number" id="subCustomInput" inputmode="numeric" min="${next}" step="${s.incremento}" placeholder="${T("m_sub_monto_desde")} ${gs(next)}" />
        <button class="btn btn-valor btn-sm" id="subCustomBtn" data-monto-min="${next}">${T("m_sub_pujar")}</button>
      </div>`;
  }
  function renderDetalle(r) {
    const s = r.subasta, cd = cdTexto(s.termina), cerrada = s.estado !== "activa" || cd.fin;
    _subData = { id: s.id, termina: s.termina, celebrado: false };
    cv().innerHTML = `<div class="section sub-detalle-wrap" style="border:none;padding-top:8px">
      <a class="sub-back">‹ ${T("m_sub_volver")}</a>
      <div class="sub-hero">${subastaMedia(s)}<span class="sub-unico">${icon("shield-check", { size: 11 })} ${T("m_sub_unico")}</span></div>
      <h2>${esc(s.titulo)}</h2><p class="lead">${esc(s.descripcion || "")}</p>
      <div class="sub-box">
        <div class="sub-lbl">${T("m_sub_actual")}</div>
        <div class="sub-amt" id="subAmt">${gs(s.puja_actual)}</div>
        <div class="precio-usd" id="subAmtUsd">${gsUsdRef(s.puja_actual)}</div>
        <div id="subState">${estadoHtml(r, cerrada)}</div>
        <div class="sub-clock${cd.urg ? " urg" : ""}" id="subClock"><span>${T("m_sub_cierra")}</span> <b id="subCd">${cerrada ? T("m_sub_cerrada") : cd.txt}</b></div>
      </div>
      <p class="sub-meta">${icon("users", { size: 14 })} <b id="subPuj">${r.pujadores}</b> ${T("m_sub_pujando")} · ${T("m_sub_tupuja")}: <b id="subMia">${r.miPuja ? gs(r.miPuja) : "—"}</b></p>
      <p class="sub-antisnipe" id="subAntisnipe"${cerrada ? ' style="display:none"' : ""}>${T("m_sub_antisnipe")}</p>
      <div id="subAcciones">${accionesHtml(r, cerrada)}</div>
      <h3 style="margin-top:24px">${T("m_sub_feed")}</h3>
      <div class="sub-feed" id="subFeed">${feedHtml(r.feed)}</div>
    </div>`;
    cv().querySelector(".sub-back").onclick = () => { window.scrollTo(0, 0); stopSub(); descSeg = "subastas"; curSubId = null; syncUrl(); vSubastas(); };
    bindPujas(s.id);
  }
  function bindPujas(id) {
    cv().querySelectorAll(".sub-puja").forEach((b) => b.addEventListener("click", () => pujar(id, Number(b.dataset.monto))));
    const pagarBtn = cv().querySelector("[data-sub-pagar]");
    if (pagarBtn) pagarBtn.addEventListener("click", () => pagarSubasta(pagarBtn.dataset.subPagar));
    // Puja de monto libre (además de los incrementos rápidos): oculta por defecto,
    // la abre quien quiera pujar una cifra puntual en vez del siguiente mínimo.
    const toggle = document.getElementById("subCustomToggle");
    const form = document.getElementById("subCustomForm");
    if (toggle && form) {
      toggle.addEventListener("click", () => { form.hidden = false; toggle.hidden = true; document.getElementById("subCustomInput").focus(); });
    }
    const customBtn = document.getElementById("subCustomBtn");
    if (customBtn) {
      customBtn.addEventListener("click", () => {
        const input = document.getElementById("subCustomInput");
        const monto = Math.round(Number(input.value) || 0);
        const min = Number(customBtn.dataset.montoMin) || 0;
        if (monto < min) { toast(T("m_sub_monto_bajo") + " " + gs(min)); return; }
        pujar(id, monto);
      });
    }
  }
  // Pago online del ganador (Pagopar) — misma pedirCedula() que la compra de membresía.
  async function pagarSubasta(id, cedula) {
    try {
      const r = await api("/subastas/" + id + "/pagar", { method: "POST", body: { cedula } });
      hap();
      if (r.ya_pagado) return vSubastaDetalle(id);
      if (r.falta_cedula) {
        const c = await OLI.pedirCedula(T("m_cedula_pago"));
        if (!c) return;
        return pagarSubasta(id, c);
      }
      location.href = r.pago.urlPago;
    } catch (e) { toast(e.message); }
  }
  function actualizarDetalle(r) {
    if (!document.getElementById("subAmt")) return; // ya no estamos en el detalle
    const s = r.subasta, cd = cdTexto(s.termina), cerrada = s.estado !== "activa" || cd.fin;
    if (_subData) _subData.termina = s.termina;
    document.getElementById("subAmt").textContent = gs(s.puja_actual);
    document.getElementById("subAmtUsd").textContent = gsUsdRef(s.puja_actual);
    document.getElementById("subState").innerHTML = estadoHtml(r, cerrada);
    document.getElementById("subPuj").textContent = r.pujadores;
    document.getElementById("subMia").textContent = r.miPuja ? gs(r.miPuja) : "—";
    document.getElementById("subFeed").innerHTML = feedHtml(r.feed);
    document.getElementById("subAcciones").innerHTML = accionesHtml(r, cerrada);
    bindPujas(s.id);
    const clock = document.getElementById("subClock"); if (clock) clock.classList.toggle("urg", cd.urg);
    const antisnipe = document.getElementById("subAntisnipe"); if (antisnipe) antisnipe.style.display = cerrada ? "none" : "";
    if (cerrada) {
      stopSub();
      document.getElementById("subCd").textContent = T("m_sub_cerrada");
      if (r.gano && _subData && !_subData.celebrado) { _subData.celebrado = true; try { OLI.confetti && OLI.confetti(); } catch (e) {} toast(T("m_sub_ganaste_txt")); }
    }
  }
  function tickCd() {
    const el = document.getElementById("subCd"); if (!el || !_subData) return;
    const cd = cdTexto(_subData.termina);
    el.textContent = cd.fin ? T("m_sub_cerrada") : cd.txt;
    const clock = document.getElementById("subClock"); if (clock) clock.classList.toggle("urg", cd.urg);
  }
  async function pujar(id, monto) {
    try {
      const r = await api("/subastas/" + id + "/pujar", { method: "POST", body: { monto } });
      hap();
      toast(r.extendida ? T("m_sub_extendido") : T("m_sub_vas_ganando"));
      try { window.OLI.track && window.OLI.track("Puja", null, { value: monto }); } catch (e) {}
    } catch (e) { toast(e.message); }
    try { const d = await api("/subastas/" + id + "?liviano=1"); actualizarDetalle(d); } catch (e) {}
  }

  // ─── Carnet digital (mismo componente que la landing, color por nivel) ───────
  // Vista UNIFICADA: carnet + nivel + beneficios + social + compartir + upsell.
  // ─── QR rotativo para usar los beneficios en caja: se renueva cada 60 s con un token firmado por el servidor ───
  let _qrTimer = null, _qrVence = 0, _qrCargando = false;
  function detenerQrBeneficios() { if (_qrTimer) clearInterval(_qrTimer); _qrTimer = null; _qrCargando = false; }
  async function refrescarQr() {
    if (_qrCargando) return;
    _qrCargando = true;
    try {
      const d = await api("/carnet/token");
      const img = document.getElementById("qrBenImg"); if (!img) return detenerQrBeneficios();
      const src = makeQR(d.token);
      // La librería del QR se carga diferida: si todavía no está, se reintenta enseguida en vez de dejar el cuadro en blanco.
      if (!src) { _qrVence = Date.now() + 700; return; }
      img.src = src;
      document.getElementById("qrBenCod").textContent = d.codigo;
      _qrVence = Date.now() + d.vence_en * 1000;
      const v = document.getElementById("qrBenVel"); if (v) v.hidden = true;
    } catch (e) {
      const v = document.getElementById("qrBenVel"); if (v) { v.hidden = false; v.textContent = T("m_qr_error"); }
      _qrVence = Date.now() + 5000; // reintenta pronto
    } finally { _qrCargando = false; }
  }
  function iniciarQrBeneficios() {
    detenerQrBeneficios();
    if (!document.getElementById("qrBen")) return;
    refrescarQr();
    _qrTimer = setInterval(() => {
      if (!document.getElementById("qrBenImg")) return detenerQrBeneficios();
      if (document.hidden) return;                       // pestaña en segundo plano: no se pide nada
      const resta = Math.max(0, Math.ceil((_qrVence - Date.now()) / 1000));
      const seg = document.getElementById("qrBenSeg"), barra = document.getElementById("qrBenBarra");
      if (seg) seg.textContent = T("m_qr_cambia") + " " + resta + " s";
      if (barra) barra.style.width = Math.min(100, (resta / 60) * 100) + "%";
      if (resta <= 0) refrescarQr();
    }, 1000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && _qrTimer) refrescarQr(); }); // al volver, token nuevo ya

  const qrListo = () => new Promise((res) => { let n = 0; (function chk() { if (window.qrcode || n++ > 40) return res(); setTimeout(chk, 50); })(); });
  const NIVEL_COLOR = { olimpista: "#c9c7c1", kids: "#ff8a80", premium: "#d9b65a", socio: "#ffffff" };
  async function vCarnet() {
    view().innerHTML = skeleton(0);
    try {
      const [carnetR, memR, cfgR] = await Promise.all([
        api("/carnet"),
        api("/membresia").catch(() => ({})),
        api("/config").catch(() => ({ tiers: [] })),
      ]);
      const carnet = carnetR.carnet;
      const membresia = memR.membresia, tier = memR.tier;
      try { localStorage.setItem("oli_carnet_offline", JSON.stringify({ carnet, ref: (SESSION.socio && SESSION.socio.ref_codigo) || "", guardado: Date.now() })); } catch (e) {}
      const pagos = (cfgR.tiers || []).filter((t) => t.nivel > 0 && t.comprable !== false);
      const esGratis = !membresia || (tier && tier.nivel === 0);
      const s = SESSION.socio;
      await qrListo(); // la librería del QR carga diferida: sin esperarla el carnet salía con "Tu QR" vacío
      const qr = makeQR(location.origin + "/c/" + encodeURIComponent(carnet.numero));
      const social = await socialPais();
      const ubic = [s.ciudad, s.pais].filter(Boolean).join(", ");
      const ubicHtml = ubic
        ? `<p class="ubic-line">${icon("map-pin", { size: 14 })} ${esc(ubic)} · <a class="ed-ubic">${T("m_editar_ubic")}</a></p>`
        : `<p class="ubic-line ubic-falta">${icon("map-pin", { size: 14 })} <a class="ed-ubic">${T("m_set_ubic")}</a></p>`;
      const socioCard = !esSocioValidado() ? `<div class="card card-socio"><div class="body">
          <span class="chip on">${icon("trophy", { size: 14 })} ${T("up_card_chip")}</span>
          <h4>${T("up_card_h")}</h4><p>${T("up_card_p")}</p>
          <button class="btn" id="upCardBtn">${T("ob_validar")}</button></div></div>` : "";
      const upsell = esGratis ? `<h3 style="margin-top:30px">${T("m_subi")}</h3><div class="grid-3">${pagos.map(cardUpsell).join("")}</div>` : "";
      view().innerHTML = `
        <div class="section" style="border:none;padding-top:8px">
          <h2>${T("m_carnet_h")}</h2>
          <p class="lead">${T("m_carnet_p")}</p>
          <div class="cn2-grid">
            <div class="cn2" id="qrBen">
              <div class="cn2-top"><img src="/assets/escudo-olimpia-blanco.png" alt="Club Olimpia" height="34" /><span class="cn2-niv" style="color:${NIVEL_COLOR[carnet.tierSlug] || "#d9b65a"}">${esc(String(carnet.tier || "Olimpista").toUpperCase())}</span></div>
              <div class="cn2-fr" aria-hidden="true"></div>
              <div class="cn2-body">
                <div class="cn2-id"><span class="cn2-nom">${esc(carnet.nombre)}</span><span class="cn2-lin">${T("m_cn_desde")} ${membresia ? fecha(membresia.inicio) : fecha(carnet.desde)}${ubic ? " · " + esc(ubic) : ""}</span></div>
                <div class="cn2-qr"><img id="qrBenImg" alt="${T("m_qr_alt")}" width="188" height="188" /><div class="qr-vel" id="qrBenVel" hidden></div></div>
                <div class="cn2-pie"><div class="cn2-barra"><span id="qrBenBarra"></span></div><span class="cn2-seg"><span id="qrBenSeg"></span> · <span id="qrBenCod">······</span></span></div>
              </div>
            </div>
            <div class="cn2-lado">
              <div class="grupo">
                <div class="grupo-fila"><span class="cn2-ico" style="color:var(--ok)">${OLI.ic(esSocioValidado() ? "verificado" : "check-circulo", 24, true)}</span>
                  <span class="grupo-tx"><b>${esSocioValidado() ? T("m_cn_socio") : T("m_cn_miembro")}</b><small>${esSocioValidado() ? T("m_cn_socio_sub") : T("m_cn_miembro_sub")}</small></span></div>
                <div class="grupo-fila"><span class="cn2-ico" style="color:var(--text-secondary)">${OLI.ic("carnet", 24)}</span><span class="grupo-tx"><b>${T("m_cn_numero")}</b></span><span class="grupo-val">${esc(carnet.numero)}</span></div>
              </div>
              <p class="cn2-nota">${T("m_cn_nota")}</p>
              <div class="carnet-acts">
                <button class="btn" id="compartir">${icon("share-2", { size: 16 })} ${T("m_compartir")}</button>
                <button class="btn btn-ig" id="compartirIG">${icon("camera", { size: 16 })} ${T("ig_compartir")}</button>
              </div>
            </div>
          </div>
          <div class="card" style="max-width:520px;margin:18px auto 0;text-align:center"><div class="body">
            <h3 style="margin:0 0 6px">${icon("users", { size: 16 })} ${T("m_hinchada_h")}</h3>
            <p class="muted" style="margin:0 0 12px">${(SESSION.referidos || 0) > 0 ? `${T("m_hinchada_1")} <strong style="color:var(--oro)">${SESSION.referidos}</strong> ${T("m_hinchada_2")}` : T("m_hinchada_0")}</p>
            <button class="btn" id="copiarRef">${T("m_copiar_ref")}</button>
          </div></div>
          <div style="text-align:center;margin-top:24px">
            <h3 style="margin:0">${T("m_sos")} ${tier ? tier.nombre : "Olimpista"} <span style="color:var(--oro)">●</span></h3>
            <p class="muted" style="margin:4px 0 0">${T("m_miembro_desde")} ${membresia ? fecha(membresia.inicio) : fecha(carnet.desde)}.</p>
            ${ubicHtml}
            ${social}
          </div>
          <ul class="benefits" style="max-width:520px;margin:18px auto 0">${(tier?.beneficios || []).map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
          ${socioCard}
          ${upsell}
        </div>`;
      view().querySelectorAll("[data-upsell]").forEach((b) => b.addEventListener("click", () => upgrade(b.dataset.upsell)));
      iniciarQrBeneficios();
      view().querySelector("#upCardBtn")?.addEventListener("click", validarSocioModal);
      view().querySelector(".ed-ubic")?.addEventListener("click", () => { activar("perfil"); setTimeout(() => focusCampo("pais"), 60); });
      view().querySelector("#compartir").onclick = async () => {
        const url = "https://www.olimpistas.com";
        // El texto termina en "...gratis, en" → le completamos con el LINK DE INVITACIÓN del socio
        // (lleva su ?ref= para atribuir a quién trae). Así compartir el carnet = sumar a tu hinchada.
        const txt = T("m_compartir_txt") + " " + OLI.refLink(SESSION.socio && SESSION.socio.ref_codigo);
        const btn = view().querySelector("#compartir"); const orig = btn.innerHTML; btn.disabled = true; btn.textContent = "…";
        try {
          // 1) Compartir el CARNET como IMAGEN (lo que el usuario espera ver en WhatsApp).
          const blob = await OLI.carnetImagen({ tierSlug: carnet.tierSlug, tierNombre: carnet.tier, nombre: carnet.nombre, numero: carnet.numero, foto: carnet.foto, qr, iso: carnet.iso });
          if (blob) {
            const file = new File([blob], "mi-carnet-olimpista.png", { type: "image/png" });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
              await navigator.share({ files: [file], title: "Mi carnet Olimpista", text: txt });
              return;
            }
            // Sin share de archivos → descargar la imagen del carnet.
            const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "mi-carnet-olimpista.png"; a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            toast(T("m_carnet_descargado") || "Carnet descargado");
            return;
          }
          // 2) Fallback: compartir/copiar el texto (que ya incluye la dirección).
          if (navigator.share) await navigator.share({ title: "Olimpistas", text: txt, url });
          else { await navigator.clipboard.writeText(txt); toast(T("m_link_copiado")); }
        } catch (e) { /* cancelado */ }
        finally { btn.disabled = false; btn.innerHTML = orig; }
      };
      view().querySelector("#compartirIG").onclick = async () => {
        const s = SESSION.socio;
        const btn = view().querySelector("#compartirIG"); const orig = btn.innerHTML; btn.disabled = true; btn.textContent = "…";
        try {
          const r = await OLI.compartirStory({
            nombre: carnet.nombre, ciudad: s.ciudad, pais: s.pais, iso: carnet.iso, foto: carnet.foto,
            caption: T("ig_caption") + " " + OLI.refLink(s && s.ref_codigo), igUrl: "https://instagram.com/olimpistascom",
          });
          if (r && r.downloaded) toast(T("m_ig_descargado"));
        } catch (e) { /* cancelado */ }
        finally { btn.disabled = false; btn.innerHTML = orig; }
      };
      const cr = view().querySelector("#copiarRef");
      if (cr) cr.onclick = async () => {
        const link = OLI.refLink(SESSION.socio && SESSION.socio.ref_codigo);
        const txt = T("m_compartir_txt") + " " + link;
        try {
          if (navigator.share) await navigator.share({ title: "Olimpistas", text: txt });
          else { await navigator.clipboard.writeText(link); toast(T("m_link_copiado")); }
        } catch (e) { /* cancelado */ }
      };
    } catch (e) {
      // Sin conexión: se muestra el último carnet que se vio (datos y número), con aviso. El QR rotativo necesita red:
      // en caja se dicta el código de socio, que el comercio también acepta.
      let g = null; try { g = JSON.parse(localStorage.getItem("oli_carnet_offline") || "null"); } catch (x) {}
      if (g && g.carnet && (!navigator.onLine || /fetch|network|load failed/i.test(String(e && e.message)))) {
        const c = g.carnet;
        view().innerHTML = `<div class="section" style="border:none;padding-top:8px"><h2>${T("m_carnet_h")}</h2><p class="lead">${T("m_carnet_p")}</p>
          <div class="cn2-grid"><div class="cn2"><div class="cn2-top"><img src="/assets/escudo-olimpia-blanco.png" alt="Club Olimpia" height="34" /><span class="cn2-niv" style="color:${NIVEL_COLOR[c.tierSlug] || "#d9b65a"}">${esc(String(c.tier || "Olimpista").toUpperCase())}</span></div>
            <div class="cn2-fr" aria-hidden="true"></div>
            <div class="cn2-body"><div class="cn2-id"><span class="cn2-nom">${esc(c.nombre)}</span><span class="cn2-lin">${esc(c.numero)}</span></div>
              <span class="cn2-offline">${OLI.ic("reloj", 16)} ${T("m_cn_offline")}</span>
              ${g.ref ? `<div class="cn2-codigo"><small>${T("m_cn_codigo")}</small><b>${esc(String(g.ref).toUpperCase())}</b></div>` : ""}
              <p class="cn2-lin" style="text-align:center">${T("m_cn_offline_p")}</p></div></div></div></div>`;
        return;
      }
      view().innerHTML = `<div class="section" style="border:none"><h2>${T("m_carnet_no")}</h2><p class="lead">${T("m_error_generico")}</p></div>`;
    }
  }

  const attr = (s) => String(s || "").replace(/"/g, "&quot;");

  init().catch((e) => { view().innerHTML = '<p class="error">' + e.message + "</p>"; });
})();
