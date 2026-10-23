/* globe.js — globo 3D (MapLibre GL, satélite) con NIVELES DE DETALLE que se
   funden con el zoom, para que se entienda de qué país es y se vaya detallando:

     z bajo  (mundo)   → 1 medallón POR PAÍS, con nombre y total (1M, 5K…)
     z medio (país)    → badges POR CIUDAD (Gran Asunción se agrupa hasta entrar)
     z alto  (ciudad)  → banderas de Olimpia por ciudad (tamaño según cantidad)
     z muy alto (calle)→ banderas individuales "en tu casa" (opt-in)

   Interfaz OLI_GLOBE:
     create(el,{onFlagClick,onPick,autoRotate,zoom,center,flagsUrl})
       → { setData(ciudades), setCountries(paises), pov, stopRotation, raw } */
window.OLI_GLOBE = (function () {
  // Cúmulos de ciudad/país: tinta, no oro — "el oro significa dinero, y acá no hay dinero" (F1.7).
  const CUMULO = "#0a0a0a", CUMULO_BORDE = "rgba(255,255,255,.35)";
  const ESTILO = {
    version: 8,
    projection: { type: "globe" },
    glyphs: "/assets/glyphs/{fontstack}/{range}.pbf", // Saira propia (scripts/generar-glyphs.mjs): sin servidores de terceros
    sources: {
      sat: {
        type: "raster", tileSize: 256, maxzoom: 19,
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
      },
      lugares: {
        type: "raster", tileSize: 256, maxzoom: 16,
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
      },
      // Calles + nombres de vías (overlay transparente para híbrido sobre satélite).
      calles: {
        type: "raster", tileSize: 256, maxzoom: 19,
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"],
      },
    },
    layers: [
      { id: "fondo", type: "background", paint: { "background-color": "#0a0a0a" } },
      { id: "sat", type: "raster", source: "sat" },
      { id: "lugares", type: "raster", source: "lugares", paint: { "raster-opacity": 0.85 } },
      // Calles: aparecen al acercar (zoom ≥ 10) para no ensuciar la vista de globo.
      { id: "calles", type: "raster", source: "calles", minzoom: 10, paint: { "raster-opacity": 0.9 } },
    ],
  };

  const lugarDe = (d) => (d.ciudad ? `${d.ciudad}, ${d.pais || ""}` : (d.pais || d.nombre || ""));

  // Texto abreviado: 1.024.501 → "1M", 5009 → "5K", 234 → "234".
  function fmt(prop) {
    return ["case",
      [">=", ["get", prop], 1000000], ["concat", ["to-string", ["/", ["round", ["/", ["get", prop], 100000]], 10]], "M"],
      [">=", ["get", prop], 1000], ["concat", ["to-string", ["round", ["/", ["get", prop], 1000]]], "K"],
      ["to-string", ["get", prop]]];
  }

  function buildFC(points) {
    return {
      type: "FeatureCollection",
      features: (points || []).filter((d) => d.lat != null && d.lng != null).map((d) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [Number(d.lng), Number(d.lat)] },
        properties: {
          iso: d.iso || "", ciudad: d.ciudad || "", nombre: d.nombre || d.pais || "",
          pais: d.pais || d.nombre || "", count: Number(d.count || 1),
        },
      })),
    };
  }

  // ── Medallón por país: mitad bandera de Olimpia (blanca/negra/blanca) + mitad país ──
  const _r = (x, a, b, w, h, c) => { x.fillStyle = c; x.fillRect(a, b, w, h + 0.4); };
  // Banderas de los 250 países: SVG propios (flag-icons, MIT) en /assets/flags/4x3/, bajados de a uno cuando aparece el país.
  const cargarBandera = (iso) => new Promise((res) => {
    if (!/^[A-Za-z]{2}$/.test(iso || "")) return res(null);
    const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null);
    img.src = "/assets/flags/4x3/" + String(iso).toLowerCase() + ".svg";
  });
  // Sin bandera propia: el medallón entero es Olimpia (franjas), nunca un color de relleno.
  const franjasOlimpia = (x, a, b, w, h) => { _r(x, a, b, w, h / 3, "#f5f5f5"); _r(x, a, b + h / 3, w, h / 3, "#141414"); _r(x, a, b + 2 * h / 3, w, h / 3, "#f5f5f5"); };
  async function medallonData(iso) {
    const flag = await cargarBandera(iso);
    const S = 128, c = 64, r = 60, top = 4, hh = 120;
    const cv = document.createElement("canvas"); cv.width = cv.height = S;
    const x = cv.getContext("2d");
    x.save(); x.beginPath(); x.arc(c, c, r, 0, Math.PI * 2); x.clip();
    _r(x, 0, top, c, hh / 3, "#f5f5f5"); _r(x, 0, top + hh / 3, c, hh / 3, "#141414"); _r(x, 0, top + 2 * hh / 3, c, hh / 3, "#f5f5f5");
    if (flag) {
      // La bandera (4:3) se escala a la altura del medallón y se recorta al centro de su mitad derecha.
      const t = document.createElement("canvas"); t.width = Math.round(hh * 4 / 3); t.height = hh;
      t.getContext("2d").drawImage(flag, 0, 0, t.width, t.height);
      x.drawImage(t, (t.width - c) / 2, 0, c, hh, c, top, c, hh);
    } else franjasOlimpia(x, c, top, c, hh);
    x.restore();
    // Aro y divisor blancos con un contorno tenue para que no se pierdan sobre el satélite claro (sin oro: acá no hay dinero).
    const trazos = (ancho) => { x.lineWidth = ancho; x.beginPath(); x.moveTo(c, top); x.lineTo(c, top + hh); x.stroke(); x.beginPath(); x.arc(c, c, r - 1.5, 0, Math.PI * 2); x.stroke(); };
    x.strokeStyle = "rgba(10,10,10,.35)"; trazos(8);
    x.strokeStyle = "#ffffff"; trazos(4);
    return x.getImageData(0, 0, S, S);
  }

  function create(el, opts = {}) {
    const ML = window.maplibregl;
    if (!ML || !el) return null;

    // Escape anti-XSS para los popups (datos de socio: nombre, ciudad).
    const esc = (window.OLI && window.OLI.esc) || ((s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));

    const map = new ML.Map({
      container: el, style: ESTILO,
      center: opts.center || [-58.4, -23.4],
      zoom: opts.zoom != null ? opts.zoom : 1.6,
      attributionControl: { compact: true }, dragRotate: true,
      cooperativeGestures: true, // mobile: 1 dedo scrollea la página, 2 dedos mueven el mapa
    });
    map.addControl(new ML.NavigationControl({ showCompass: false }), "top-right");
    if (ML.FullscreenControl) map.addControl(new ML.FullscreenControl({ container: el.closest(".globo-stage") || el }), "top-right");
    // El mapa es una imagen para un lector de pantalla: la descripción real está en la lista de países de abajo.
    try { const cv = map.getCanvas(); cv.setAttribute("role", "img"); cv.setAttribute("aria-label", "Mapa de olimpistas en el mundo"); } catch (e) {}

    // Rotación automática (estilo Google Earth): gira al cargar y se DETIENE del
    // todo al primer gesto del usuario. No reanuda → nunca pelea con el toque.
    // Basada en timer (no en el chain de moveend) para evitar trabarse.
    // Respeta prefers-reduced-motion: si el usuario pidió menos movimiento, NO auto-rota.
    const _reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let girando = opts.autoRotate !== false && !_reduce, rotT = null;
    function girar() {
      clearTimeout(rotT);
      if (!girando) return;
      if (map.getZoom() < 3.5 && !map.isMoving()) {
        const c = map.getCenter(); c.lng -= 2.6;
        map.easeTo({ center: c, duration: 1000, easing: (t) => t });
      }
      rotT = setTimeout(girar, 1050);
    }
    function detenerGiro() { girando = false; clearTimeout(rotT); }
    ["mousedown", "touchstart", "wheel", "dragstart", "rotatestart", "pitchstart"].forEach((ev) => map.on(ev, detenerGiro));

    let pendPenas = [];
    let popup = null, ready = false, pendCiudades = null, pendPaises = null, _casasT = null, _vos = null;
    const UMBRAL_CASAS = 12; // las casas (punto exacto) aparecen recién a nivel calle

    // Genera y registra un medallón por país (mitad Olimpia / mitad país).
    const caminosDe = (paises) => (window.OLI_GEO ? window.OLI_GEO.caminosFC(paises || []) : { type: "FeatureCollection", features: [] });
    function asegurarMedallones(paises) {
      (paises || []).forEach((p) => {
        const id = "pais-" + (p.iso || "");
        if (p.iso && !map.hasImage(id)) medallonData(p.iso).then((d) => { if (!map.hasImage(id)) map.addImage(id, d, { pixelRatio: 2 }); }).catch(() => {});
      });
    }

    function cargarIconoBandera() {
      return new Promise((res) => {
        const img = new Image(); img.crossOrigin = "anonymous";
        img.onload = () => {
          const w = 110, h = Math.round(w * ((img.height / img.width) || 0.72));
          // Aire extra para el contorno + la sombra suave (F1.7): sin esto, la bandera
          // blanca desaparece sobre el satelital claro.
          const pad = 6;
          const c = document.createElement("canvas"); c.width = (w + pad * 2) * 2; c.height = (h + pad * 2) * 2;
          const cx = c.getContext("2d");
          cx.save();
          cx.shadowColor = "rgba(0,0,0,.45)"; cx.shadowBlur = 6; cx.shadowOffsetY = 2;
          cx.drawImage(img, pad * 2, pad * 2, w * 2, h * 2);
          cx.restore();
          cx.strokeStyle = "rgba(10,10,10,.25)"; cx.lineWidth = 2;
          cx.strokeRect(pad * 2 + 1, pad * 2 + 1, w * 2 - 2, h * 2 - 2);
          try { if (!map.hasImage("bandera")) map.addImage("bandera", cx.getImageData(0, 0, c.width, c.height), { pixelRatio: 2 }); } catch (e) {}
          res();
        };
        img.onerror = () => res();
        img.src = "/assets/flag-olimpia.svg?v=88";
      });
    }

    function popupEn(coords, html) {
      if (popup) popup.remove();
      popup = new ML.Popup({ offset: 14, closeButton: false, maxWidth: "210px" }).setLngLat(coords).setHTML(html).addTo(map);
    }
    const popPena = (p) => `<strong>${esc(p.nombre)}</strong><span>${esc(p.ciudad || "")} · ${Number(p.altas || 0).toLocaleString("es-PY")} hinchas</span><a href="/?pena=${encodeURIComponent(p.slug)}">Sumarme</a>`;
    function pintarPenas() {
      const fc = { type: "FeatureCollection", features: pendPenas.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [Number(p.lng), Number(p.lat)] }, properties: { slug: p.slug, nombre: p.nombre, ciudad: p.ciudad || "", altas: Number(p.altas || 0) } })) };
      if (map.getSource("penas")) { map.getSource("penas").setData(fc); return; }
      map.addSource("penas", { type: "geojson", data: fc });
      const pintar = () => {
        if (map.getLayer("penas-escudo")) return;
        map.addLayer({ id: "penas-escudo", type: "symbol", source: "penas", minzoom: 4.5,
          layout: { "icon-image": "escudo-pena", "icon-allow-overlap": true, "icon-size": ["interpolate", ["linear"], ["zoom"], 4.5, 0.22, 10, 0.34, 14, 0.42] },
          paint: { "icon-opacity": ["interpolate", ["linear"], ["zoom"], 4.5, 0, 5.5, 1] } });
        map.on("click", "penas-escudo", (e) => { const f = e.features[0]; popupEn(f.geometry.coordinates.slice(), popPena(f.properties)); });
        map.on("mouseenter", "penas-escudo", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "penas-escudo", () => { map.getCanvas().style.cursor = ""; });
      };
      if (map.hasImage("escudo-pena")) return pintar();
      const img = new Image();
      img.onload = () => { try { const c = document.createElement("canvas"); c.width = 96; c.height = Math.round(96 * (img.height / img.width)); const x = c.getContext("2d"); x.shadowColor = "rgba(0,0,0,.6)"; x.shadowBlur = 6; x.drawImage(img, 6, 6, 84, c.height - 12); map.addImage("escudo-pena", x.getImageData(0, 0, c.width, c.height), { pixelRatio: 2 }); } catch (e) {} pintar(); };
      img.onerror = () => {};
      img.src = "/assets/escudo.png"; // escudo oficial tal cual (no el negativo)
    }
    const popCiudad = (p) => `<strong>${esc(lugarDe(p))}</strong><span>${Number(p.count || 1).toLocaleString("es-PY")} Olimpista${(p.count || 1) === 1 ? "" : "s"}</span>`;

    // h3-js (216 KB) solo se baja la primera vez que se acerca el mapa a nivel barrio.
    let _h3P = null;
    const cargarH3 = () => _h3P || (_h3P = window.h3 ? Promise.resolve() : new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = "/assets/vendor/h3-js.umd.js"; s.onload = res; s.onerror = () => { _h3P = null; rej(new Error("h3")); }; document.head.appendChild(s);
    }));
    const VACIO = { type: "FeatureCollection", features: [] };
    const UMBRAL_BARRIOS = 11;
    function celdasFC(celdas) {
      return { type: "FeatureCollection", features: (celdas || []).map((x) => ({ type: "Feature", properties: { n: x.n, r: x.r },
        geometry: { type: "Polygon", coordinates: [window.h3.cellToBoundary(x.c, true)] } })) };
    }
    function refrescarBarrios() {
      const src = map.getSource("barrios");
      if (!opts.celdasUrl || !src) return;
      const b = map.getBounds();
      // El servidor rechaza recuadros de más de 2°: a zoom bajo no se piden barrios (ahí mandan países y ciudades).
      if (map.getZoom() < UMBRAL_BARRIOS || b.getEast() - b.getWest() > 2 || b.getNorth() - b.getSouth() > 2) { src.setData(VACIO); return; }
      clearTimeout(_casasT);
      _casasT = setTimeout(() => {
        const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(4)).join(",");
        Promise.all([fetch(opts.celdasUrl + "?bbox=" + bbox, { credentials: "same-origin" }).then((r) => r.json()), cargarH3()])
          .then(([j]) => { if (map.getSource("barrios")) map.getSource("barrios").setData(celdasFC(j.celdas)); })
          .catch(() => {});
      }, 250);
    }

    function refrescarCasas() {
      if (!opts.flagsUrl || !map.getSource("casas")) return;
      if (map.getZoom() < UMBRAL_CASAS) { map.getSource("casas").setData({ type: "FeatureCollection", features: [] }); return; }
      clearTimeout(_casasT);
      _casasT = setTimeout(() => {
        const b = map.getBounds();
        const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(4)).join(",");
        // Máximo 40 marcadores individuales visibles a la vez (F1.7): lo que exceda
        // queda agrupado en el cúmulo más cercano en vez de saturar el mapa.
        fetch(opts.flagsUrl + "?bbox=" + bbox + "&limit=40", { credentials: "same-origin" })
          .then((r) => r.json())
          .then((j) => { if (map.getSource("casas")) map.getSource("casas").setData(buildFC(j.flags || [])); })
          .catch(() => {});
      }, 250);
    }

    function addLayers() {
      if (map.getSource("ciudades")) return;
      map.addSource("paises", { type: "geojson", data: buildFC(pendPaises || []) });
      // "Todos los caminos llevan al Club Olimpia": un arco de círculo máximo por país hacia el club (solo a zoom bajo).
      map.addSource("caminos", { type: "geojson", data: caminosDe(pendPaises) });
      map.addSource("ciudades", {
        type: "geojson", data: buildFC(pendCiudades || []),
        cluster: true, clusterMaxZoom: 8, clusterRadius: 52,
        clusterProperties: { sum: ["+", ["get", "count"]] },
      });

      const RADIO_SUM = ["interpolate", ["linear"], ["get", "sum"], 1, 12, 1000, 16, 20000, 24, 200000, 34, 700000, 46];
      const RADIO_CIUDAD = ["interpolate", ["linear"], ["get", "count"], 1, 11, 1000, 15, 20000, 22, 200000, 32];
      const TXT = (size) => ({ "text-font": ["Saira Bold"], "text-size": size, "text-allow-overlap": true });
      const TXT_PAINT = { "text-color": "#fff" };
      const opa = (...stops) => ["interpolate", ["linear"], ["zoom"], ...stops];

      // ── Tier 1: PAÍS (mundo) → medallón mitad Olimpia / mitad país. Fade out ~4.2→5 ──
      const fadePais = opa(0, 1, 4.2, 1, 5, 0);
      map.addLayer({ id: "caminos-linea", type: "line", source: "caminos", layout: { "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-opacity": opa(0, 0.6, 4.2, 0.6, 5.2, 0),
          "line-width": ["interpolate", ["linear"], ["get", "count"], 1, 1.6, 5000, 2.2, 100000, 3, 1000000, 4.5] } });
      map.addLayer({ id: "pais-badge", type: "symbol", source: "paises",
        layout: { "icon-image": ["concat", "pais-", ["get", "iso"]], "icon-anchor": "bottom", "icon-allow-overlap": true,
          "icon-size": ["interpolate", ["linear"], ["get", "count"], 1, 0.55, 5000, 0.65, 100000, 0.9, 1024501, 1.25] },
        paint: { "icon-opacity": fadePais } });
      map.addLayer({ id: "pais-count", type: "symbol", source: "paises",
        layout: { "text-field": fmt("count"), "text-font": ["Saira Bold"], "text-size": 14,
          "text-anchor": "top", "text-offset": [0, 0.5], "text-allow-overlap": true },
        paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.6, "text-opacity": fadePais } });
      map.addLayer({ id: "pais-nombre", type: "symbol", source: "paises",
        layout: { "text-field": ["get", "nombre"], "text-font": ["Saira SemiBold"], "text-size": 12,
          "text-anchor": "top", "text-offset": [0, 1.9], "text-allow-overlap": false, "text-optional": true },
        paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3, "text-opacity": fadePais } });

      // ── Tier 2: CIUDAD agrupada (racimo). Fade in ~4.2→5 ──
      const fadeCluster = opa(4.2, 0, 5, 0.96);
      map.addLayer({ id: "ciudad-cluster", type: "circle", source: "ciudades", filter: ["has", "point_count"],
        paint: { "circle-color": CUMULO, "circle-stroke-color": CUMULO_BORDE, "circle-stroke-width": 2,
          "circle-radius": RADIO_SUM, "circle-opacity": fadeCluster, "circle-stroke-opacity": fadeCluster } });
      map.addLayer({ id: "ciudad-cluster-count", type: "symbol", source: "ciudades", filter: ["has", "point_count"],
        layout: { "text-field": fmt("sum"), ...TXT(13) }, paint: { ...TXT_PAINT, "text-opacity": fadeCluster } });

      // ── Tier 2b: CIUDAD suelta como badge. Visible ~5→8.4, luego cede a la bandera ──
      const fadeBadge = opa(4.2, 0, 5, 0.96, 8, 0.96, 8.6, 0);
      map.addLayer({ id: "ciudad-badge", type: "circle", source: "ciudades", filter: ["!", ["has", "point_count"]],
        paint: { "circle-color": CUMULO, "circle-stroke-color": CUMULO_BORDE, "circle-stroke-width": 2,
          "circle-radius": RADIO_CIUDAD, "circle-opacity": fadeBadge, "circle-stroke-opacity": fadeBadge } });
      map.addLayer({ id: "ciudad-badge-count", type: "symbol", source: "ciudades", filter: ["!", ["has", "point_count"]],
        layout: { "text-field": fmt("count"), ...TXT(12) }, paint: { ...TXT_PAINT, "text-opacity": fadeBadge } });

      // ── Tier 3: BANDERA por ciudad. Aparece ~7.8, se desvanece a nivel calle (~13.5)
      //    para dejar paso a las casas. Tamaño sobrio (zoom × leve factor por cantidad). ──
      const cf = ["interpolate", ["linear"], ["get", "count"], 1, 0.85, 5000, 1.05, 200000, 1.3];
      map.addLayer({ id: "ciudad-flag", type: "symbol", source: "ciudades", filter: ["!", ["has", "point_count"]],
        layout: { "icon-image": "bandera", "icon-allow-overlap": true, "icon-anchor": "bottom",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 8, ["*", 0.16, cf], 11, ["*", 0.24, cf], 14, ["*", 0.26, cf]],
          "text-field": ["get", "ciudad"], "text-font": ["Saira SemiBold"], "text-size": 11,
          "text-offset": [0, 0.7], "text-anchor": "top", "text-optional": true, "text-allow-overlap": false },
        paint: { "icon-opacity": opa(7.8, 0, 8.6, 1, 12, 1, 13.5, 0), "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3, "text-opacity": opa(8.2, 0, 9, 1, 12, 1, 13.5, 0) } });

      // ── Tier 4 (barrios): hexágonos H3 con k-anonimato. Nunca una casa: cada celda cuenta hinchas (≥ 3) ──
      if (opts.celdasUrl) {
        map.addSource("barrios", { type: "geojson", data: VACIO });
        map.addLayer({ id: "barrios-fill", type: "fill", source: "barrios",
          paint: { "fill-color": "#ffffff", "fill-opacity": ["interpolate", ["linear"], ["get", "n"], 3, 0.3, 30, 0.8],
            "fill-opacity-transition": { duration: 300 } } });
        map.addLayer({ id: "barrios-linea", type: "line", source: "barrios",
          paint: { "line-color": "#0a0a0a", "line-opacity": 0.55, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 16, 1.4] } });
        map.on("click", "barrios-fill", (e) => {
          const n = Number(e.features[0].properties.n) || 0;
          popupEn([e.lngLat.lng, e.lngLat.lat], `<strong>${n.toLocaleString("es-PY")} Olimpistas</strong><span>en este barrio</span>`);
        });
        map.on("mouseenter", "barrios-fill", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "barrios-fill", () => { map.getCanvas().style.cursor = ""; });
        map.on("moveend", refrescarBarrios);
        refrescarBarrios();
      } else if (opts.flagsUrl) {
        map.addSource("casas", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        // Sin "text-field": ni el nombre ni la ciudad viajan en /api/flags (dato personal expuesto
        // sin necesidad): la bandera sola ya cuenta la historia.
        map.addLayer({ id: "casas", type: "symbol", source: "casas",
          layout: { "icon-image": "bandera", "icon-allow-overlap": true, "icon-anchor": "bottom",
            "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.2, 15, 0.3, 18, 0.4] },
          paint: { "icon-opacity": opa(11.5, 0, 12.5, 1) } });
        map.on("click", "casas", (e) => {
          const f = e.features[0];
          popupEn(f.geometry.coordinates.slice(), `<strong><img class="pop-fl" src="/assets/flag-olimpia.svg" alt="" /> Olimpista</strong>`);
        });
        map.on("moveend", refrescarCasas);
        refrescarCasas();
      }

      // ── Interacciones: tocar para acercar / ver popup ──
      map.on("click", "pais-badge", (e) => {
        const f = e.features[0];
        map.easeTo({ center: f.geometry.coordinates, zoom: 5.6, duration: 1000 });
      });
      map.on("click", "ciudad-cluster", (e) => {
        const f = map.queryRenderedFeatures(e.point, { layers: ["ciudad-cluster"] })[0];
        if (!f) return;
        map.getSource("ciudades").getClusterExpansionZoom(f.properties.cluster_id)
          .then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: Math.max(z, map.getZoom() + 1.5), duration: 900 }))
          .catch(() => {});
      });
      const popClick = (e) => { const f = e.features[0]; popupEn(f.geometry.coordinates.slice(), popCiudad(f.properties)); };
      map.on("click", "ciudad-badge", popClick);
      map.on("click", "ciudad-flag", popClick);
      ["pais-badge", "ciudad-cluster", "ciudad-badge", "ciudad-flag", "casas"].forEach((id) => {
        map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
      });
    }

    map.once("load", async () => {
      try { map.setSky({ "sky-color": "#0a0a0a", "horizon-color": "#0a0a0a", "fog-color": "#0a0a0a", "fog-ground-blend": 0.4 }); } catch (e) {}
      await cargarIconoBandera();
      addLayers();
      ready = true;
      if (pendCiudades && map.getSource("ciudades")) map.getSource("ciudades").setData(buildFC(pendCiudades));
      if (pendPaises && map.getSource("paises")) { asegurarMedallones(pendPaises); map.getSource("paises").setData(buildFC(pendPaises)); if (map.getSource("caminos")) map.getSource("caminos").setData(caminosDe(pendPaises)); }
      girar();
      if (pendPenas.length) pintarPenas();
    });

    if (opts.onPick) {
      map.on("click", (e) => {
        const capas = ["pais-badge", "ciudad-cluster", "ciudad-badge", "ciudad-flag", "casas"].filter((l) => map.getLayer(l));
        if (map.queryRenderedFeatures(e.point, { layers: capas }).length) return;
        opts.onPick(e.lngLat.lat, e.lngLat.lng);
      });
    }

    return {
      setData(ciudades) {
        pendCiudades = ciudades || [];
        if (ready && map.getSource("ciudades")) map.getSource("ciudades").setData(buildFC(pendCiudades));
        return this;
      },
      setCountries(paises) {
        pendPaises = paises || [];
        if (ready && map.getSource("paises")) { asegurarMedallones(pendPaises); map.getSource("paises").setData(buildFC(pendPaises)); if (map.getSource("caminos")) map.getSource("caminos").setData(caminosDe(pendPaises)); }
        return this;
      },
      pov(p) { if (p) map.flyTo({ center: [p.lng, p.lat], zoom: p.zoom != null ? p.zoom : 2.4, duration: 1600 }); return this; },
      // "Tu bandera aterrizó": vuela a la ubicación y deja caer un marcador destacado.
      destacar(p) {
        if (!p || p.lat == null) return this;
        detenerGiro();
        map.flyTo({ center: [p.lng, p.lat], zoom: p.zoom != null ? p.zoom : 8.5, duration: 2400, essential: true });
        const node = document.createElement("div");
        node.className = "mapa-vos";
        node.innerHTML = `<img src="/assets/flag-olimpia.svg?v=88" alt="" /><span>${p.label || "¡Vos!"}</span>`;
        if (_vos) { _vos.remove(); _vos = null; }
        let puesto = false;
        const poner = () => { if (puesto) return; puesto = true; _vos = new ML.Marker({ element: node, anchor: "bottom" }).setLngLat([p.lng, p.lat]).addTo(map); };
        map.once("moveend", poner);
        setTimeout(poner, 2600);
        return this;
      },
      stopRotation() { detenerGiro(); return this; },
      // Vistas rápidas de la botonera: el mundo (y retoma el giro), un país por su recuadro, o un punto (tu ciudad).
      vista(nombre, p) {
        if (nombre === "mundo") { map.flyTo({ center: [-58, -20], zoom: 1.6, duration: 1400 }); if (!_reduce) { girando = true; map.once("moveend", () => girar()); } }
        else if (nombre === "pais" && p && p.bbox) { detenerGiro(); map.fitBounds(p.bbox, { padding: 40, duration: 1400, maxZoom: 7 }); }
        else if (nombre === "ciudad" && p && p.lat != null) { detenerGiro(); map.flyTo({ center: [p.lng, p.lat], zoom: p.zoom || 10, duration: 1800 }); }
        return this;
      },
      // Peñas verificadas con ubicación: escudo blanco desde zoom medio; al tocar, nombre, ciudad y "Sumarme".
      setPenas(lista) {
        pendPenas = (lista || []).filter((p) => p.lat != null && p.lng != null);
        if (ready) pintarPenas();
        return this;
      },
      abrirPena(p) {
        if (!p || p.lat == null) return this;
        detenerGiro();
        map.flyTo({ center: [p.lng, p.lat], zoom: 10.5, duration: 1800, essential: true });
        let puesto = false;
        const poner = () => { if (puesto) return; puesto = true; popupEn([p.lng, p.lat], popPena(p)); };
        map.once("moveend", poner); setTimeout(poner, 2000);
        return this;
      },
      etiqueta(txt) { try { map.getCanvas().setAttribute("aria-label", txt); } catch (e) {} return this; },
      raw: map,
    };
  }

  return { create };
})();
