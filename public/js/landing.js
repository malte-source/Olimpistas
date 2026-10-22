/* landing.js — embudo de captación: registro gratis + upsell a Kids/Premium. */
(function () {
  const { api, precioTier, toast, yo, carnet, makeQR, currency, setCurrency, esc, gs, gsUsdRef, artSvg } = window.OLI;
  const I18N = window.OLI_I18N;
  const T = (k) => (I18N ? I18N.t(k) : k);
  const LANG = I18N ? I18N.lang() : "es";
  const fld = (obj, base) => (LANG === "en" && obj[base + "_en"] != null ? obj[base + "_en"] : obj[base]); // pick es/en
  let CONFIG = null;
  let SESSION = null;
  let intentTier = null; // nivel que se quiso comprar antes de registrarse
  let intentSub = null;  // subasta en la que se quiso pujar antes de registrarse

  // Wireo estático (no depende de la sesión/config): mostrar/ocultar contraseña.
  if (window.OLI.wirePasswordToggles) window.OLI.wirePasswordToggles();

  async function init() {
    CONFIG = await api("/config");
    SESSION = await yo();
    await initIdiomaMoneda();
    document.getElementById("heroTitle").textContent = fld(CONFIG.brand, "lema");
    document.getElementById("heroSub").textContent = fld(CONFIG.brand, "bajada");
    document.getElementById("heroCta").textContent = fld(CONFIG.brand, "ctaPrincipal");
    const heroStatNiveles = document.getElementById("heroStatNiveles");
    if (heroStatNiveles) heroStatNiveles.textContent = CONFIG.tiers.length;
    renderTiers();
    renderNav();
    wireModal();
    document.getElementById("heroCta").onclick = () => empezarGratis();
    const navCta = document.getElementById("navCta");
    if (navCta) navCta.onclick = () => empezarGratis();
    const pago = new URLSearchParams(location.search).get("pago_simulado");
    if (pago) confirmarSimulado(pago);
    // Intención de pujar (viene de /subasta/:id cuando no hay sesión) → abrir registro
    // y, al terminar, ir directo a esa subasta dentro de la app.
    const qs = new URLSearchParams(location.search);
    if (qs.get("intent") === "pujar" && qs.get("sub")) {
      intentSub = qs.get("sub");
      if (SESSION) location.href = "/miembro?sub=" + encodeURIComponent(intentSub);
      else openModal("registro");
    }
    renderDestacado();
    initMundo();
  }

  // Slot destacado del home: si hay una subasta EN VIVO, la muestra arriba como gancho
  // principal (link a la página dedicada). Si no hay, no muestra nada (queda el hero normal).
  function cdCorto(t) {
    const ms = new Date(t).getTime() - Date.now(); if (ms <= 0) return "cerrada";
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d > 0 ? d + "d " + h + "h" : h > 0 ? h + "h " + m + "m" : m + "m";
  }
  // Foto real del lote si el admin la subió; si no, el mismo placeholder de gradiente
  // que usa el resto de la app (misma lógica que subastaMedia() en socio.js).
  function destacadoMedia(s) { return (s.imagen_url || s.imagen) ? '<img src="' + esc(s.imagen_url || s.imagen) + '" alt="" decoding="async" />' : artSvg(s.id, s.titulo, s.emoji || OLI.icon("gavel", { size: 34 })); }
  function destacadoCard(s) {
    return '<a class="destacado" href="/subasta/' + encodeURIComponent(s.slug || s.id) + '">' +
      '<div class="destacado-media">' + destacadoMedia(s) +
      '<span class="destacado-live"><span class="destacado-dot"></span>' + T("m_sub_envivo") + '</span>' +
      '<span class="destacado-clock">' + OLI.icon("hourglass", { size: 14 }) + ' ' + cdCorto(s.termina) + '</span></div>' +
      '<div class="destacado-info">' +
      '<span class="destacado-tag">' + T("tab_subastas") + '</span>' +
      '<h3 class="destacado-titulo">' + esc(s.titulo) + '</h3>' +
      '<div class="destacado-precio-row">' +
      '<div class="destacado-precio"><span class="destacado-precio-lbl">' + T("m_sub_actual") + '</span><strong>' + gs(s.puja_actual) + '</strong><span class="precio-usd">' + gsUsdRef(s.puja_actual) + '</span></div>' +
      '<span class="destacado-pujadores">' + OLI.icon("users", { size: 14 }) + ' ' + s.pujadores + ' ' + T("m_sub_pujando") + '</span></div>' +
      '<span class="destacado-cta">' + T("m_sub_pujar") + ' →</span></div></a>';
  }
  async function renderDestacado() {
    const host = document.getElementById("destacadoWrap"); if (!host) return;
    let items = [];
    try { ({ items } = await api("/subastas")); } catch (e) { return; }
    // Todas las activas, no solo la primera — con 2+ subastas en vivo a la vez (ej. las
    // dos del Clásico Ida 2026) antes se mostraba una sola y la otra quedaba invisible
    // en el home (seguía viéndose en Descubrir, pero nada la anunciaba acá).
    const activas = (items || []).filter((x) => x.estado === "activa");
    // Sin subasta en vivo no queda nada para mostrar en la columna del hero — la
    // ocultamos entera (si no, .hero-side reserva 340-380px vacíos en desktop).
    if (!activas.length) { const side = document.getElementById("heroSide"); if (side) side.hidden = true; return; }
    host.innerHTML = activas.map(destacadoCard).join("");
  }

  // Carga diferida de assets (devuelve Promise). Para el mapa pesado (MapLibre).
  function cargarCss(href) {
    return new Promise((res) => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; l.onload = res; l.onerror = res; document.head.appendChild(l); });
  }
  function cargarJs(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  const cargarMapa = () => OLI.cargarMapa(); // misma carga diferida que usa la app del hincha (common.js)

  async function initIdiomaMoneda() {
    OLI.initThemeToggle("themeSw");
    const langSw = document.getElementById("langSw");
    if (langSw) {
      if (LANG === "en") { langSw.textContent = "ES"; langSw.href = "/"; }
      else { langSw.textContent = "EN"; langSw.href = "/en"; }
      langSw.addEventListener("click", () => { try { localStorage.setItem("oli_lang", LANG === "en" ? "es" : "en"); } catch (e) {} });
    }
    let stored = ""; try { stored = localStorage.getItem("oli_cur") || ""; } catch (e) {}
    if (!stored) {
      try {
        const { pais } = await api("/geo");
        const detectada = pais && pais.iso === "PY" ? "PYG" : "USD";
        setCurrency(detectada);
        // Comunicar la auto-detección arriba (antes quedaba invisible, enterrada en el
        // selector de la sección de planes): quien entra desde afuera de Paraguay ve
        // enseguida que los precios ya están en su moneda, no en guaraníes por defecto.
        if (detectada === "USD") {
          const note = document.getElementById("heroCurNote");
          if (note) { note.innerHTML = T("hero_cur_usd"); note.hidden = false; }
        }
      } catch { setCurrency("PYG"); }
    }
    const curSel = document.getElementById("curSel");
    if (curSel) {
      const opts = curSel.querySelectorAll(".cur-opt");
      const sync = () => opts.forEach((o) => o.classList.toggle("on", o.dataset.cur === currency()));
      sync();
      opts.forEach((o) => o.addEventListener("click", () => {
        setCurrency(o.dataset.cur); sync(); renderTiers();
        const note = document.getElementById("heroCurNote"); if (note) note.hidden = true; // ya no hace falta el aviso
      }));
    }
  }

  // ─── Olimpistas en el mundo: contador (inmediato) + globo (lazy) ─────────────
  async function initMundo() {
    let stats;
    try { stats = await api("/stats"); } catch { return; }
    animarContador(stats.total);
    document.getElementById("contadorPaises").textContent = stats.paises;
    const heroStatOli = document.getElementById("heroStatOli"), heroStatPaises = document.getElementById("heroStatPaises");
    if (heroStatOli && stats.total > 0) heroStatOli.textContent = stats.total.toLocaleString(LANG === "en" ? "en-US" : "es-PY");
    if (heroStatPaises && stats.paises) heroStatPaises.textContent = stats.paises;
    renderTopPaises(stats.porPais);
    // Prueba social en el hero
    if (stats.total > 0) {
      const hs = document.getElementById("heroSocial");
      const loc = LANG === "en" ? "en-US" : "es-PY";
      if (hs) { hs.textContent = `${T("social_pre")} ${stats.total.toLocaleString(loc)} ${T("social_in")} ${stats.paises} ${stats.paises === 1 ? T("pais") : T("paises")}`; hs.hidden = false; }
    }
    document.getElementById("globoCta").onclick = () => empezarGratis();

    // ── Conteo EN VIVO: trae el objetivo del server cada 20s y sube suave ──────
    // (sin recargar la página; arranca tras la animación inicial)
    {
      const loc = LANG === "en" ? "en-US" : "es-PY";
      const numEl = document.getElementById("contadorNum");
      const paisesEl = document.getElementById("contadorPaises");
      const heroEl = document.getElementById("heroSocial");
      let meta = stats.total, mostrado = stats.total, paisesMeta = stats.paises;
      let paisBase = (stats.porPais || []).reduce((a, p) => a + Number(p.count || 0), 0) || stats.total;
      // El ranking sube EN VIVO: escala cada país por (mostrado / base) para que
      // crezca en proporción al contador, entre refrescos del /stats.
      function renderRankingVivo() {
        const lista = stats.porPais;
        if (!lista || !lista.length || !paisBase) return;
        const f = mostrado / paisBase;
        renderTopPaises(lista.map((p) => ({ ...p, count: Math.round(Number(p.count || 0) * f) })));
      }
      // Total casi en vivo: endpoint liviano (solo total + países), cache corto.
      async function pollContador() {
        if (document.hidden) return; // pestaña en segundo plano: no gastar requests
        try {
          const s = await api("/contador");
          if (!s || typeof s.total !== "number") return;
          if (s.total >= meta) { meta = s.total; if (s.paises) paisesMeta = s.paises; }
        } catch (e) {}
      }
      // Globo + top países: payload pesado, refresco espaciado.
      async function pollGlobo() {
        if (document.hidden) return;
        try {
          const s = await api("/stats");
          if (!s || !Array.isArray(s.porPais)) return;
          stats.porPais = s.porPais;
          stats.puntos = s.puntos || s.porPais;
          if (s.paises) paisesMeta = s.paises;
          paisBase = s.porPais.reduce((a, p) => a + Number(p.count || 0), 0) || meta;
          renderRankingVivo();
          const gl = window.__oliGl;
          if (gl) { try { gl.setCountries(s.porPais); gl.setData(s.puntos || s.porPais); } catch (e) {} }
        } catch (e) {}
      }
      function tick() {
        if (mostrado >= meta) return;
        const paso = Math.max(1, Math.ceil((meta - mostrado) / 8));
        mostrado = Math.min(meta, mostrado + paso);
        if (numEl) numEl.textContent = mostrado.toLocaleString(loc);
        if (paisesEl && paisesMeta) paisesEl.textContent = paisesMeta;
        if (heroStatOli) heroStatOli.textContent = mostrado.toLocaleString(loc);
        if (heroStatPaises && paisesMeta) heroStatPaises.textContent = paisesMeta;
        if (heroEl && !heroEl.hidden) {
          heroEl.textContent = `${T("social_pre")} ${mostrado.toLocaleString(loc)} ${T("social_in")} ${paisesMeta} ${paisesMeta === 1 ? T("pais") : T("paises")}`;
        }
        renderRankingVivo();
      }
      setTimeout(() => {
        mostrado = meta;                  // sincroniza con lo que dejó animarContador
        setInterval(pollContador, 30000); // actualiza el total cada 30s (mismo ritmo)
        setInterval(pollGlobo, 30000);    // globo/top (cache 30s)
        setInterval(tick, 600);           // conteo corto suave hacia el nuevo valor
        pollContador();
      }, 1800);
    }

    // El globo (MapLibre, ~1MB) se carga recién cuando la sección entra en viewport.
    const stage = document.getElementById("mundo");
    const construir = async () => {
      await cargarMapa();
      if (!window.OLI_GLOBE) return;
      const gl = window.OLI_GLOBE.create(document.getElementById("globo"), { maxH: 600, flagsUrl: "/api/flags", celdasUrl: "/api/mapa/celdas" });
      if (!gl) return;
      gl.setCountries(stats.porPais || []);                    // nivel mundo: 1 badge por país
      gl.setData(stats.puntos || stats.porPais || []);         // nivel ciudad: badges/banderas
      gl.pov({ lat: -23.4, lng: -58.4, zoom: 2.4 });           // arranca mostrando Sudamérica (PY destacado)
      window.__oliGl = gl;
      iniciarVistasMapa(gl);
      etiquetarMapa(stats.porPais || []);
      iniciarTiempo(gl);
      iniciarPenas(gl);
      focarNuevo();                                            // si recién se inscribió, vuela a su ciudad
    };

    // Botonera "Mi ciudad · Paraguay · El mundo": encontrarse en el globo sin tener que girarlo a mano.
    const PY_BBOX = [[-62.65, -27.6], [-54.25, -19.3]];
    function iniciarVistasMapa(gl) {
      const barra = document.getElementById("globoVista"); if (!barra || barra.dataset.listo) return; barra.dataset.listo = "1";
      const marcar = (v) => barra.querySelectorAll("button[data-vista]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.vista === v)));
      barra.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-vista]"); if (!b) return;
        const v = b.dataset.vista; marcar(v);
        if (v === "mundo") gl.vista("mundo");
        else if (v === "pais") gl.vista("pais", { bbox: PY_BBOX });
        else {
          if (!navigator.geolocation) return OLI.toast(T("mapa_sin_geo"));
          OLI.toast(T("mapa_buscando"));
          navigator.geolocation.getCurrentPosition(
            (pos) => gl.vista("ciudad", { lat: pos.coords.latitude, lng: pos.coords.longitude, zoom: 10 }),
            () => { OLI.toast(T("mapa_sin_geo")); marcar("pais"); gl.vista("pais", { bbox: PY_BBOX }); },
            { timeout: 8000, maximumAge: 600000 });
        }
      });
      // Si el hincha mueve el mapa a mano, ninguna vista rápida sigue "activa".
      gl.raw.on("dragstart", () => marcar(""));
    }
    // Peñas en el mapa + "Encontrá tu peña": la más cercana según la ubicación del navegador.
    async function iniciarPenas(gl) {
      let lista = []; try { lista = (await api("/penas")).items || []; } catch (e) { return; }
      const ubicadas = lista.filter((p) => p.lat != null && p.lng != null);
      if (!ubicadas.length) return;
      gl.setPenas(ubicadas);
      const caja = document.getElementById("globoPena"), btn = document.getElementById("penaCerca"); if (!caja || !btn) return;
      caja.hidden = false;
      btn.addEventListener("click", () => {
        if (!navigator.geolocation) return OLI.toast(T("mapa_sin_geo"));
        OLI.toast(T("mapa_pena_buscando"));
        navigator.geolocation.getCurrentPosition(async (pos) => {
          try {
            const r = await api("/penas?cerca=" + pos.coords.latitude.toFixed(4) + "," + pos.coords.longitude.toFixed(4));
            const p = (r.items || [])[0];
            if (!p) return OLI.toast(T("mapa_pena_ninguna"));
            gl.abrirPena(p);
            OLI.toast(p.nombre + " · " + T("mapa_pena_km").replace("{km}", Math.round(p.distancia_km).toLocaleString(LANG === "en" ? "en-US" : "es-PY")));
          } catch (e) { OLI.toast(T("mapa_pena_ninguna")); }
        }, () => OLI.toast(T("mapa_sin_geo")), { timeout: 8000, maximumAge: 600000 });
      });
    }
    // "Mirá cómo crece": altas acumuladas mes a mes (solo hinchas reales). Reproduce o se arrastra a mano.
    async function iniciarTiempo(gl) {
      const caja = document.getElementById("globoTiempo"); if (!caja || caja.dataset.listo) return;
      let meses; try { meses = (await api("/mapa/historia")).meses || []; } catch (e) { return; }
      if (meses.length < 2) return;
      caja.dataset.listo = "1"; caja.hidden = false;
      const rango = document.getElementById("tiempoRango"), play = document.getElementById("tiempoPlay"), et = document.getElementById("tiempoEt");
      const loc = LANG === "en" ? "en-US" : "es-PY";
      rango.max = String(meses.length - 1); rango.value = String(meses.length - 1);
      const mostrar = (i) => {
        const m = meses[i];
        const lista = (stats.porPais || []).filter((p) => m.porPais[p.iso]).map((p) => ({ ...p, count: m.porPais[p.iso] }));
        gl.setCountries(lista);
        const nombre = new Date(m.mes + "-01T12:00:00").toLocaleDateString(loc, { month: "long", year: "numeric" });
        et.textContent = nombre + " · " + m.total.toLocaleString(loc) + " " + T("mapa_reales");
      };
      let timer = null;
      const parar = () => { clearInterval(timer); timer = null; play.textContent = T("mapa_crece_play"); };
      rango.addEventListener("input", () => { parar(); mostrar(Number(rango.value)); });
      play.addEventListener("click", () => {
        if (timer) return parar();
        let i = Number(rango.value) >= meses.length - 1 ? 0 : Number(rango.value);
        play.textContent = T("mapa_crece_pausa");
        mostrar(i); rango.value = String(i);
        timer = setInterval(() => { i++; if (i >= meses.length) return parar(); rango.value = String(i); mostrar(i); }, 1800);
      });
    }

    // Descripción del mapa para lectores de pantalla + lista completa de países (la alternativa accesible).
    function etiquetarMapa(lista) {
      const total = (lista || []).reduce((a, p) => a + Number(p.count || 0), 0);
      const loc = LANG === "en" ? "en-US" : "es-PY";
      if (window.__oliGl && window.__oliGl.etiqueta) window.__oliGl.etiqueta(T("mapa_aria").replace("{n}", total.toLocaleString(loc)).replace("{p}", String(lista.length)));
    }

    // "Tu bandera aterrizó": tras inscribirse, vuela a su ciudad y la destaca.
    function focarNuevo() {
      const gl = window.__oliGl; if (!gl) return;
      let info; try { info = JSON.parse(sessionStorage.getItem("oli_nuevo") || "null"); } catch (e) {}
      if (!info) return;
      try { sessionStorage.removeItem("oli_nuevo"); } catch (e) {}
      // Desde el perfil ("Ver cómo queda") llega el punto exacto elegido: se vuela directo ahí.
      if (info.lat != null && info.lng != null) { gl.destacar({ lat: Number(info.lat), lng: Number(info.lng), label: "¡Vos!" }); return; }
      let pt = (stats.puntos || []).find((p) => (p.ciudad || "").toLowerCase() === (info.ciudad || "").toLowerCase() && (!info.iso || p.iso === info.iso));
      if (!pt) pt = (stats.porPais || []).find((p) => p.iso === info.iso);
      if (!pt) return;
      gl.destacar({ lat: pt.lat, lng: pt.lng, label: "¡Vos!" });
    }
    window.OLI_MUNDO_FOCAR = focarNuevo;

    if ("IntersectionObserver" in window && stage) {
      const io = new IntersectionObserver((ents) => {
        if (ents.some((e) => e.isIntersecting)) { io.disconnect(); construir(); }
      }, { rootMargin: "200px" });
      io.observe(stage);
    } else {
      construir();
    }
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
    if (!list || !list.length) { el.innerHTML = `<p class="muted">${T("top_empty")}</p>`; return; }
    const loc = LANG === "en" ? "en-US" : "es-PY";
    const top = list.slice(0, 8);
    el.innerHTML = `<h4>${T("top_title")}</h4>` + top.map((p, i) =>
      `<div class="tp-row"><span>${i + 1}. ${OLI.esc(p.nombre)}</span><strong>${Number(p.count).toLocaleString(loc)}</strong></div>`
    ).join("") + (list.length > top.length ? `<button type="button" class="tp-todos" id="tpTodos">${T("mapa_ver_todos")}</button>` : "");
    // Lista completa de países: lo mismo que dibuja el mapa, en texto (lectores de pantalla y quien no quiere girar el globo).
    const ol = document.getElementById("mapaLista"), sum = document.getElementById("mapaListaSum"), wrap = document.getElementById("mapaListaWrap");
    if (ol && sum) {
      sum.textContent = T("mapa_ver_los").replace("{n}", String(list.length));
      ol.innerHTML = list.map((p) => `<li><span>${OLI.esc(p.nombre)}</span><strong>${Number(p.count).toLocaleString(loc)}</strong></li>`).join("");
      const todos = document.getElementById("tpTodos");
      if (todos) todos.onclick = () => { wrap.open = true; wrap.scrollIntoView({ behavior: "smooth", block: "center" }); };
    }
    if (window.__oliGl && window.__oliGl.etiqueta) etiquetarMapa(list);
  }

  function renderNav() {
    const btn = document.getElementById("accederBtn");
    if (SESSION) { btn.textContent = T("nav_micuenta"); btn.onclick = () => (location.href = "/miembro"); }
    else { btn.textContent = T("nav_ingresar"); btn.onclick = () => openModal("login"); }
    const navCta = document.getElementById("navCta");
    if (navCta) navCta.style.display = SESSION ? "none" : "";
    // Nav/footer "Subastas"/"Sorteos": con sesión van directo a esa pestaña de Descubrir
    // (ya tiene URL propia gracias al router); sin sesión, el href por defecto ancla
    // al destacado en el hero (lo único que hay para mostrar sin haberse registrado).
    [["navSubastas", "subastas"], ["navSorteos", "sorteos"], ["footerSubastas", "subastas"], ["footerSorteos", "sorteos"]]
      .forEach(([id, seg]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("click", (e) => {
          if (!SESSION) return; // sin sesión: dejar el href normal (ancla al destacado)
          e.preventDefault();
          location.href = "/miembro/descubrir/" + seg;
        });
      });
  }

  function empezarGratis() {
    if (SESSION) return (location.href = "/miembro");
    // Inscripción guiada (mobile-first, con selfie). Fallback al modal si no cargó.
    if (window.OLI_ONB) return OLI_ONB.start({ config: CONFIG, onLogin: () => openModal("login") });
    openModal("registro");
  }

  function renderTiers() {
    const cont = document.getElementById("tiers");
    const previewQR = makeQR("https://olimpistas.olimpia.com"); // QR genérico para la vista previa
    cont.innerHTML = CONFIG.tiers.filter((t) => t.comprable !== false).map((t) => {
      const p = precioTier(t, CONFIG.brand.usdRate);
      const bullets = fld(t, "beneficios").map((b) => `<li>${esc(b)}</li>`).join("");
      const carnetHtml = carnet({ tierSlug: t.slug, tierNombre: t.nombre, nombre: "Tu nombre",
        numero: "OLI-••••••••", qr: previewQR });
      return `
      <div class="tier ${(t.destacado || t.recomendado) ? "tier-destacado" : ""}">
        ${t.recomendado ? `<span class="tier-ribbon oro">${T("ribbon_rec")}</span>` : (t.destacado ? `<span class="tier-ribbon">${T("ribbon")}</span>` : "")}
        ${carnetHtml}
        <div class="tier-body${t.recomendado ? " tier-body-oro" : ""}">
          <div class="price"><div class="big">${p.big}</div><div class="small">${p.small}</div></div>
          <button class="btn cta ${t.recomendado ? "btn-valor" : (t.nivel === 0 ? "" : "btn-ghost")}" data-tier="${t.slug}">${fld(t, "cta")}</button>
          <ul class="benefits">${bullets}</ul>
        </div>
      </div>`;
    }).join("");
    cont.querySelectorAll("button[data-tier]").forEach((b) =>
      b.addEventListener("click", () => unirse(b.dataset.tier))
    );
  }

  async function unirse(tierSlug, cedula) {
    const tier = CONFIG.tiers.find((t) => t.slug === tierSlug);
    if (!SESSION) { intentTier = tierSlug; return openModal("registro"); }
    if (!tier || tier.nivel === 0) return (location.href = "/miembro"); // ya sos Olimpista
    try {
      const r = await api("/membresia/unirse", { method: "POST", body: { tier: tierSlug, moneda: currency(), cedula } });
      if (r.falta_cedula) {                                    // Pagopar exige cédula: la pedimos y reintentamos
        const c = await OLI.pedirCedula(T("m_cedula_pago"));
        if (!c) return;
        return unirse(tierSlug, c);
      }
      if (r.gratis) return (location.href = "/miembro");
      window.OLI.track("InicioPago", "InitiateCheckout", { content_name: tierSlug });
      location.href = r.pago.urlPago; // simulado → /miembro?pago_simulado=… | real → URL de PAGOPAR
    } catch (e) { toast(e.message); }
  }

  async function confirmarSimulado(pedidoId) {
    try { await api("/pagos/confirmar-simulado", { method: "POST", body: { pedidoId } }); location.href = "/miembro"; }
    catch (e) { toast(e.message); }
  }

  // ─── Modal auth ────────────────────────────────────────────────────────────
  let mode = "registro", _modalPrevFocus = null;
  function _modalKey(e) {
    const bg = document.getElementById("modalBg");
    if (!bg.classList.contains("open")) return;
    if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
    if (e.key === "Tab") {
      const f = Array.prototype.slice.call(bg.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])'))
        .filter((el) => el.offsetParent !== null); // solo visibles (el form cambia según modo)
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function openModal(m) {
    mode = m; syncModal();
    _modalPrevFocus = document.activeElement;
    document.getElementById("modalBg").classList.add("open");
    document.addEventListener("keydown", _modalKey, true);
    setTimeout(() => { const i = document.getElementById(mode === "registro" ? "nombre" : "email"); if (i) i.focus(); }, 40);
  }
  function closeModal() {
    document.getElementById("modalBg").classList.remove("open");
    document.getElementById("modalError").textContent = "";
    document.removeEventListener("keydown", _modalKey, true);
    if (_modalPrevFocus && _modalPrevFocus.focus) { try { _modalPrevFocus.focus(); } catch (e) {} }
  }

  function syncModal() {
    const reg = mode === "registro";
    document.getElementById("modalTitle").textContent = reg ? T("m_title_reg") : T("m_title_login");
    document.getElementById("modalSub").textContent = reg ? T("m_sub_reg") : T("m_sub_login");
    document.getElementById("nombreField").style.display = reg ? "block" : "none";
    document.getElementById("apellidoField").style.display = reg ? "block" : "none";
    document.getElementById("password2Field").style.display = reg ? "block" : "none";
    document.getElementById("consentRow").style.display = reg ? "flex" : "none";
    document.getElementById("submitBtn").textContent = reg ? T("m_submit_reg") : T("m_submit_login");
    document.getElementById("switchMode").innerHTML = reg
      ? `${T("m_switch_reg")} <a id="switchLink">${T("m_switch_reg_a")}</a>`
      : `${T("m_switch_login")} <a id="switchLink">${T("m_switch_login_a")}</a>`;
    document.getElementById("switchLink").onclick = () => { mode = reg ? "login" : "registro"; syncModal(); };
    const fr = document.getElementById("forgotRow"); if (fr) fr.hidden = reg; // solo en login
  }

  async function recuperarPass() {
    const email = document.getElementById("email").value.trim();
    const errEl = document.getElementById("modalError");
    if (!email) { errEl.textContent = T("m_forgot_need"); return; }
    errEl.textContent = "";
    try {
      await api("/auth/recuperar", { method: "POST", body: { email } });
      document.getElementById("modalSub").textContent = T("m_forgot_sent");
      document.getElementById("forgotRow").hidden = true;
    } catch (e) { errEl.textContent = e.message; }
  }

  function wireModal() {
    document.getElementById("modalBg").addEventListener("click", (e) => { if (e.target.id === "modalBg") closeModal(); });
    document.getElementById("submitBtn").addEventListener("click", submitAuth);
    document.getElementById("password").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); });
    const fl = document.getElementById("forgotLink"); if (fl) fl.addEventListener("click", recuperarPass);
  }

  async function submitAuth() {
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const nombre = document.getElementById("nombre").value.trim();
    const apellido = document.getElementById("apellido").value.trim();
    const errEl = document.getElementById("modalError");
    errEl.textContent = "";
    if (mode === "registro") {
      if (password !== document.getElementById("password2").value) { errEl.textContent = T("ob_pass2_err"); return; }
      if (!document.getElementById("consent").checked) { errEl.textContent = T("consent_err"); return; }
    }
    const btn = document.getElementById("submitBtn");
    const t0 = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = T("m_guardando"); } // evita doble envío
    try {
      const path = mode === "registro" ? "/auth/registro" : "/auth/login";
      const body = mode === "registro" ? { email, password, nombre, apellido, ref: window.OLI.ref(), pena: window.OLI.pena(), idioma: LANG } : { email, password };
      SESSION = await api(path, { method: "POST", body });
      if (mode === "registro") window.OLI.track("Registro", "CompleteRegistration");
      closeModal();
      if (intentSub) { const sub = intentSub; intentSub = null; location.href = "/miembro?sub=" + encodeURIComponent(sub); return; } // quería pujar
      const intent = intentTier; intentTier = null;
      const tier = intent && CONFIG.tiers.find((t) => t.slug === intent);
      if (tier && tier.nivel > 0) unirse(intent); // quería un nivel pago → al pago
      else location.href = "/miembro";
    } catch (e) { errEl.textContent = e.message; }
    finally { if (btn) { btn.disabled = false; btn.textContent = t0; } }
  }

  // Arranque resiliente: si una llamada inicial falla (típico bache de red móvil), reintenta
  // con backoff antes de mostrar error. La parte que puede fallar (api/config, yo) está al
  // tope de init() antes de tocar el DOM, así que reintentar de nuevo es seguro.
  (async function arranque() {
    for (let i = 1; i <= 3; i++) {
      try { await init(); return; }
      catch (e) {
        if (i === 3) { document.getElementById("heroSub").textContent = T("m_error_generico"); return; }
        await new Promise((r) => setTimeout(r, 700 * i)); // 0.7s, 1.4s
      }
    }
  })();
})();
