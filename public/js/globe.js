/* globe.js — globo 3D (MapLibre GL, satélite) con NIVELES DE DETALLE que se
   funden con el zoom, para que se entienda de qué país es y se vaya detallando:

     z bajo  (mundo)   → 1 badge dorado POR PAÍS, con nombre y total (1M, 5K…)
     z medio (país)    → badges POR CIUDAD (Gran Asunción se agrupa hasta entrar)
     z alto  (ciudad)  → banderas de Olimpia por ciudad (tamaño según cantidad)
     z muy alto (calle)→ banderas individuales "en tu casa" (opt-in)

   Interfaz OLI_GLOBE:
     create(el,{onFlagClick,onPick,autoRotate,zoom,center,flagsUrl})
       → { setData(ciudades), setCountries(paises), pov, stopRotation, raw } */
window.OLI_GLOBE = (function () {
  const ORO = "#c9a227", ORO_BORDE = "#1a1500";
  const ESTILO = {
    version: 8,
    projection: { type: "globe" },
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
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
    },
    layers: [
      { id: "fondo", type: "background", paint: { "background-color": "#0b0b0f" } },
      { id: "sat", type: "raster", source: "sat" },
      { id: "lugares", type: "raster", source: "lugares", paint: { "raster-opacity": 0.85 } },
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
  function _star(x, cx, cy, r) {
    x.beginPath();
    for (let i = 0; i < 5; i++) {
      const a1 = -Math.PI / 2 + i * 2 * Math.PI / 5;
      x.lineTo(cx + r * Math.cos(a1), cy + r * Math.sin(a1));
      const a2 = a1 + Math.PI / 5;
      x.lineTo(cx + r * 0.45 * Math.cos(a2), cy + r * 0.45 * Math.sin(a2));
    }
    x.closePath(); x.fill();
  }
  // Banderas simplificadas (lado derecho del medallón, caja [a,b,w,h]).
  const FLAG = {
    PY:(x,a,b,w,h)=>{_r(x,a,b,w,h/3,'#D52B1E');_r(x,a,b+h/3,w,h/3,'#fff');_r(x,a,b+2*h/3,w,h/3,'#0038A8');},
    AR:(x,a,b,w,h)=>{_r(x,a,b,w,h/3,'#74ACDF');_r(x,a,b+h/3,w,h/3,'#fff');_r(x,a,b+2*h/3,w,h/3,'#74ACDF');},
    RU:(x,a,b,w,h)=>{_r(x,a,b,w,h/3,'#fff');_r(x,a,b+h/3,w,h/3,'#0039A6');_r(x,a,b+2*h/3,w,h/3,'#D52B1E');},
    DE:(x,a,b,w,h)=>{_r(x,a,b,w,h/3,'#111');_r(x,a,b+h/3,w,h/3,'#DD0000');_r(x,a,b+2*h/3,w,h/3,'#FFCE00');},
    VE:(x,a,b,w,h)=>{_r(x,a,b,w,h/3,'#FFCC00');_r(x,a,b+h/3,w,h/3,'#00247D');_r(x,a,b+2*h/3,w,h/3,'#CF142B');},
    ES:(x,a,b,w,h)=>{_r(x,a,b,w,h*0.25,'#AA151B');_r(x,a,b+h*0.25,w,h*0.5,'#F1BF00');_r(x,a,b+h*0.75,w,h*0.25,'#AA151B');},
    CO:(x,a,b,w,h)=>{_r(x,a,b,w,h*0.5,'#FCD116');_r(x,a,b+h*0.5,w,h*0.25,'#003893');_r(x,a,b+h*0.75,w,h*0.25,'#CE1126');},
    EC:(x,a,b,w,h)=>{_r(x,a,b,w,h*0.5,'#FFDD00');_r(x,a,b+h*0.5,w,h*0.25,'#034EA2');_r(x,a,b+h*0.75,w,h*0.25,'#ED1C24');},
    MX:(x,a,b,w,h)=>{_r(x,a,b,w/3,h,'#006847');_r(x,a+w/3,b,w/3,h,'#fff');_r(x,a+2*w/3,b,w/3,h,'#CE1126');},
    IT:(x,a,b,w,h)=>{_r(x,a,b,w/3,h,'#009246');_r(x,a+w/3,b,w/3,h,'#fff');_r(x,a+2*w/3,b,w/3,h,'#CE2B37');},
    PE:(x,a,b,w,h)=>{_r(x,a,b,w/3,h,'#D91023');_r(x,a+w/3,b,w/3,h,'#fff');_r(x,a+2*w/3,b,w/3,h,'#D91023');},
    CA:(x,a,b,w,h)=>{_r(x,a,b,w,h,'#fff');_r(x,a,b,w*0.28,h,'#FF0000');_r(x,a+w*0.72,b,w*0.28,h,'#FF0000');x.fillStyle='#FF0000';x.beginPath();x.arc(a+w/2,b+h/2,h*0.14,0,7);x.fill();},
    PT:(x,a,b,w,h)=>{_r(x,a,b,w*0.4,h,'#006600');_r(x,a+w*0.4,b,w*0.6,h,'#FF0000');x.fillStyle='#FFD700';x.beginPath();x.arc(a+w*0.4,b+h/2,h*0.12,0,7);x.fill();},
    BR:(x,a,b,w,h)=>{_r(x,a,b,w,h,'#009C3B');const cx=a+w/2,cy=b+h/2;x.fillStyle='#FFDF00';x.beginPath();x.moveTo(cx,cy-h*0.36);x.lineTo(a+w*0.92,cy);x.lineTo(cx,cy+h*0.36);x.lineTo(a+w*0.08,cy);x.closePath();x.fill();x.fillStyle='#002776';x.beginPath();x.arc(cx,cy,h*0.16,0,7);x.fill();},
    JP:(x,a,b,w,h)=>{_r(x,a,b,w,h,'#fff');x.fillStyle='#BC002D';x.beginPath();x.arc(a+w/2,b+h/2,h*0.26,0,7);x.fill();},
    TR:(x,a,b,w,h)=>{_r(x,a,b,w,h,'#E30A17');const cx=a+w*0.52,cy=b+h/2,rr=h*0.22;x.fillStyle='#fff';x.beginPath();x.arc(cx,cy,rr,0,7);x.fill();x.fillStyle='#E30A17';x.beginPath();x.arc(cx+rr*0.5,cy,rr*0.82,0,7);x.fill();},
    US:(x,a,b,w,h)=>{const n=7;for(let i=0;i<n;i++)_r(x,a,b+i*h/n,w,h/n,i%2?'#fff':'#B22234');_r(x,a,b,w*0.45,h*0.45,'#3C3B6E');},
    SE:(x,a,b,w,h)=>{_r(x,a,b,w,h,'#006AA7');_r(x,a,b+h*0.4,w,h*0.2,'#FECC00');_r(x,a+w*0.26,b,w*0.18,h,'#FECC00');},
    AU:(x,a,b,w,h)=>{_r(x,a,b,w,h,'#00247D');x.strokeStyle='#fff';x.lineWidth=h*0.06;x.beginPath();x.moveTo(a,b);x.lineTo(a+w*0.45,b+h*0.45);x.moveTo(a+w*0.45,b);x.lineTo(a,b+h*0.45);x.stroke();x.fillStyle='#fff';_star(x,a+w*0.72,b+h*0.72,h*0.14);},
    NZ:(x,a,b,w,h)=>{_r(x,a,b,w,h,'#00247D');x.strokeStyle='#fff';x.lineWidth=h*0.06;x.beginPath();x.moveTo(a,b);x.lineTo(a+w*0.45,b+h*0.45);x.moveTo(a+w*0.45,b);x.lineTo(a,b+h*0.45);x.stroke();x.fillStyle='#CC142B';_star(x,a+w*0.72,b+h*0.55,h*0.12);},
    CL:(x,a,b,w,h)=>{_r(x,a,b,w,h*0.5,'#fff');_r(x,a,b+h*0.5,w,h*0.5,'#D52B1E');_r(x,a,b,w*0.4,h*0.5,'#0039A6');x.fillStyle='#fff';_star(x,a+w*0.2,b+h*0.25,h*0.13);},
  };
  function medallonData(iso) {
    const S = 128, c = 64, r = 60, top = 4, hh = 120;
    const cv = document.createElement("canvas"); cv.width = cv.height = S;
    const x = cv.getContext("2d");
    x.save(); x.beginPath(); x.arc(c, c, r, 0, Math.PI * 2); x.clip();
    _r(x, 0, top, c, hh / 3, "#f5f5f5"); _r(x, 0, top + hh / 3, c, hh / 3, "#141414"); _r(x, 0, top + 2 * hh / 3, c, hh / 3, "#f5f5f5");
    (FLAG[iso] || ((xx, a, b, w, h) => _r(xx, a, b, w, h, "#c9a227")))(x, c, top, c, hh);
    x.restore();
    x.strokeStyle = "#c9a227"; x.lineWidth = 3; x.beginPath(); x.moveTo(c, top); x.lineTo(c, top + hh); x.stroke();
    x.lineWidth = 5; x.beginPath(); x.arc(c, c, r - 1.5, 0, Math.PI * 2); x.stroke();
    return x.getImageData(0, 0, S, S);
  }

  function create(el, opts = {}) {
    const ML = window.maplibregl;
    if (!ML || !el) return null;

    const map = new ML.Map({
      container: el, style: ESTILO,
      center: opts.center || [-58.4, -23.4],
      zoom: opts.zoom != null ? opts.zoom : 1.6,
      attributionControl: { compact: true }, dragRotate: true,
    });
    map.addControl(new ML.NavigationControl({ showCompass: false }), "top-right");

    // Rotación automática: pausa al interactuar, reanuda tras inactividad (zoom bajo).
    let girando = opts.autoRotate !== false, idle = null;
    function girar() {
      if (!girando) return;
      if (map.getZoom() < 4) {
        const c = map.getCenter();
        c.lng -= 360 / 140 * 1.2;
        map.easeTo({ center: c, duration: 1200, easing: (t) => t });
      }
    }
    map.on("moveend", girar);
    if (opts.autoRotate !== false) {
      const pausar = () => { girando = false; clearTimeout(idle); idle = setTimeout(() => { girando = true; girar(); }, opts.reanudarMs || 4000); };
      ["mousedown", "touchstart", "wheel", "drag"].forEach((ev) => map.on(ev, pausar));
    }

    let popup = null, ready = false, pendCiudades = null, pendPaises = null, _casasT = null, _vos = null;
    const UMBRAL_CASAS = 12; // las casas (punto exacto) aparecen recién a nivel calle

    // Genera y registra un medallón por país (mitad Olimpia / mitad país).
    function asegurarMedallones(paises) {
      (paises || []).forEach((p) => {
        const id = "pais-" + (p.iso || "");
        if (p.iso && !map.hasImage(id)) { try { map.addImage(id, medallonData(p.iso), { pixelRatio: 2 }); } catch (e) {} }
      });
    }

    function cargarIconoBandera() {
      return new Promise((res) => {
        const img = new Image(); img.crossOrigin = "anonymous";
        img.onload = () => {
          const w = 110, h = Math.round(w * ((img.height / img.width) || 0.72));
          const c = document.createElement("canvas"); c.width = w * 2; c.height = h * 2;
          c.getContext("2d").drawImage(img, 0, 0, w * 2, h * 2);
          try { if (!map.hasImage("bandera")) map.addImage("bandera", c.getContext("2d").getImageData(0, 0, w * 2, h * 2), { pixelRatio: 2 }); } catch (e) {}
          res();
        };
        img.onerror = () => res();
        img.src = "/assets/flag-olimpia.svg?v=4";
      });
    }

    function popupEn(coords, html) {
      if (popup) popup.remove();
      popup = new ML.Popup({ offset: 14, closeButton: false, maxWidth: "210px" }).setLngLat(coords).setHTML(html).addTo(map);
    }
    const popCiudad = (p) => `<strong>${lugarDe(p)}</strong><span>${Number(p.count || 1).toLocaleString("es-PY")} Olimpista${(p.count || 1) === 1 ? "" : "s"}</span>`;

    function refrescarCasas() {
      if (!opts.flagsUrl || !map.getSource("casas")) return;
      if (map.getZoom() < UMBRAL_CASAS) { map.getSource("casas").setData({ type: "FeatureCollection", features: [] }); return; }
      clearTimeout(_casasT);
      _casasT = setTimeout(() => {
        const b = map.getBounds();
        const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(4)).join(",");
        fetch(opts.flagsUrl + "?bbox=" + bbox + "&limit=800", { credentials: "same-origin" })
          .then((r) => r.json())
          .then((j) => { if (map.getSource("casas")) map.getSource("casas").setData(buildFC(j.flags || [])); })
          .catch(() => {});
      }, 250);
    }

    function addLayers() {
      if (map.getSource("ciudades")) return;
      map.addSource("paises", { type: "geojson", data: buildFC(pendPaises || []) });
      map.addSource("ciudades", {
        type: "geojson", data: buildFC(pendCiudades || []),
        cluster: true, clusterMaxZoom: 8, clusterRadius: 52,
        clusterProperties: { sum: ["+", ["get", "count"]] },
      });

      const RADIO_SUM = ["interpolate", ["linear"], ["get", "sum"], 1, 12, 1000, 16, 20000, 24, 200000, 34, 700000, 46];
      const RADIO_CIUDAD = ["interpolate", ["linear"], ["get", "count"], 1, 11, 1000, 15, 20000, 22, 200000, 32];
      const TXT = (size) => ({ "text-font": ["Open Sans Bold"], "text-size": size, "text-allow-overlap": true });
      const TXT_PAINT = { "text-color": ORO_BORDE };
      const opa = (...stops) => ["interpolate", ["linear"], ["zoom"], ...stops];

      // ── Tier 1: PAÍS (mundo) → medallón mitad Olimpia / mitad país. Fade out ~4.2→5 ──
      const fadePais = opa(0, 1, 4.2, 1, 5, 0);
      map.addLayer({ id: "pais-badge", type: "symbol", source: "paises",
        layout: { "icon-image": ["concat", "pais-", ["get", "iso"]], "icon-anchor": "bottom", "icon-allow-overlap": true,
          "icon-size": ["interpolate", ["linear"], ["get", "count"], 1, 0.4, 5000, 0.52, 100000, 0.8, 1024501, 1.2] },
        paint: { "icon-opacity": fadePais } });
      map.addLayer({ id: "pais-count", type: "symbol", source: "paises",
        layout: { "text-field": fmt("count"), "text-font": ["Open Sans Bold"], "text-size": 14,
          "text-anchor": "top", "text-offset": [0, 0.5], "text-allow-overlap": true },
        paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.6, "text-opacity": fadePais } });
      map.addLayer({ id: "pais-nombre", type: "symbol", source: "paises",
        layout: { "text-field": ["get", "nombre"], "text-font": ["Open Sans Bold"], "text-size": 12,
          "text-anchor": "top", "text-offset": [0, 1.9], "text-allow-overlap": false, "text-optional": true },
        paint: { "text-color": "#e7c64b", "text-halo-color": "#000", "text-halo-width": 1.3, "text-opacity": fadePais } });

      // ── Tier 2: CIUDAD agrupada (racimo). Fade in ~4.2→5 ──
      const fadeCluster = opa(4.2, 0, 5, 0.96);
      map.addLayer({ id: "ciudad-cluster", type: "circle", source: "ciudades", filter: ["has", "point_count"],
        paint: { "circle-color": ORO, "circle-stroke-color": ORO_BORDE, "circle-stroke-width": 2,
          "circle-radius": RADIO_SUM, "circle-opacity": fadeCluster, "circle-stroke-opacity": fadeCluster } });
      map.addLayer({ id: "ciudad-cluster-count", type: "symbol", source: "ciudades", filter: ["has", "point_count"],
        layout: { "text-field": fmt("sum"), ...TXT(13) }, paint: { ...TXT_PAINT, "text-opacity": fadeCluster } });

      // ── Tier 2b: CIUDAD suelta como badge. Visible ~5→8.4, luego cede a la bandera ──
      const fadeBadge = opa(4.2, 0, 5, 0.96, 8, 0.96, 8.6, 0);
      map.addLayer({ id: "ciudad-badge", type: "circle", source: "ciudades", filter: ["!", ["has", "point_count"]],
        paint: { "circle-color": ORO, "circle-stroke-color": ORO_BORDE, "circle-stroke-width": 2,
          "circle-radius": RADIO_CIUDAD, "circle-opacity": fadeBadge, "circle-stroke-opacity": fadeBadge } });
      map.addLayer({ id: "ciudad-badge-count", type: "symbol", source: "ciudades", filter: ["!", ["has", "point_count"]],
        layout: { "text-field": fmt("count"), ...TXT(12) }, paint: { ...TXT_PAINT, "text-opacity": fadeBadge } });

      // ── Tier 3: BANDERA por ciudad. Aparece ~7.8, se desvanece a nivel calle (~13.5)
      //    para dejar paso a las casas. Tamaño sobrio (zoom × leve factor por cantidad). ──
      const cf = ["interpolate", ["linear"], ["get", "count"], 1, 0.85, 5000, 1.05, 200000, 1.3];
      map.addLayer({ id: "ciudad-flag", type: "symbol", source: "ciudades", filter: ["!", ["has", "point_count"]],
        layout: { "icon-image": "bandera", "icon-allow-overlap": true, "icon-anchor": "bottom",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 8, ["*", 0.16, cf], 11, ["*", 0.24, cf], 14, ["*", 0.26, cf]],
          "text-field": ["get", "ciudad"], "text-font": ["Open Sans Bold"], "text-size": 11,
          "text-offset": [0, 0.7], "text-anchor": "top", "text-optional": true, "text-allow-overlap": false },
        paint: { "icon-opacity": opa(7.8, 0, 8.6, 1, 12, 1, 13.5, 0), "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3, "text-opacity": opa(8.2, 0, 9, 1, 12, 1, 13.5, 0) } });

      // ── Tier 4: CASAS opt-in (punto exacto). Solo a zoom alto ──
      if (opts.flagsUrl) {
        map.addSource("casas", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "casas", type: "symbol", source: "casas",
          layout: { "icon-image": "bandera", "icon-allow-overlap": true, "icon-anchor": "bottom",
            "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.2, 15, 0.3, 18, 0.4],
            "text-field": ["get", "nombre"], "text-font": ["Open Sans Bold"], "text-size": 11,
            "text-offset": [0, 0.7], "text-anchor": "top", "text-optional": true, "text-allow-overlap": false },
          paint: { "icon-opacity": opa(11.5, 0, 12.5, 1), "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3, "text-opacity": opa(12.5, 0, 13.2, 1) } });
        map.on("click", "casas", (e) => {
          const f = e.features[0], p = f.properties;
          popupEn(f.geometry.coordinates.slice(), `<strong><img class="pop-fl" src="/assets/flag-olimpia.svg" alt="" /> ${p.nombre || "Un Olimpista"}</strong><span>${p.ciudad || ""}</span>`);
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
      try { map.setSky({ "sky-color": "#0b0b0f", "horizon-color": "#1a1a22", "fog-color": "#0b0b0f", "fog-ground-blend": 0.4 }); } catch (e) {}
      await cargarIconoBandera();
      addLayers();
      ready = true;
      if (pendCiudades && map.getSource("ciudades")) map.getSource("ciudades").setData(buildFC(pendCiudades));
      if (pendPaises && map.getSource("paises")) { asegurarMedallones(pendPaises); map.getSource("paises").setData(buildFC(pendPaises)); }
      girar();
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
        if (ready && map.getSource("paises")) { asegurarMedallones(pendPaises); map.getSource("paises").setData(buildFC(pendPaises)); }
        return this;
      },
      pov(p) { if (p) map.flyTo({ center: [p.lng, p.lat], zoom: p.zoom != null ? p.zoom : 2.4, duration: 1600 }); return this; },
      // "Tu bandera aterrizó": vuela a la ubicación y deja caer un marcador destacado.
      destacar(p) {
        if (!p || p.lat == null) return this;
        girando = false;
        map.flyTo({ center: [p.lng, p.lat], zoom: p.zoom != null ? p.zoom : 8.5, duration: 2400, essential: true });
        const node = document.createElement("div");
        node.className = "mapa-vos";
        node.innerHTML = `<img src="/assets/flag-olimpia.svg?v=4" alt="" /><span>${p.label || "¡Vos!"}</span>`;
        if (_vos) { _vos.remove(); _vos = null; }
        let puesto = false;
        const poner = () => { if (puesto) return; puesto = true; _vos = new ML.Marker({ element: node, anchor: "bottom" }).setLngLat([p.lng, p.lat]).addTo(map); };
        map.once("moveend", poner);
        setTimeout(poner, 2600);
        return this;
      },
      stopRotation() { girando = false; return this; },
      raw: map,
    };
  }

  return { create };
})();
