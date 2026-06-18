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

    let popup = null, ready = false, pendCiudades = null, pendPaises = null, _casasT = null;
    const UMBRAL_CASAS = 9;

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
      popup = new ML.Popup({ offset: 16, closeButton: false }).setLngLat(coords).setHTML(html).addTo(map);
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

      const RADIO_PAIS = ["interpolate", ["linear"], ["get", "count"], 1, 12, 200, 15, 5000, 20, 50000, 28, 300000, 40, 1024501, 52];
      const RADIO_SUM = ["interpolate", ["linear"], ["get", "sum"], 1, 12, 1000, 16, 20000, 24, 200000, 34, 700000, 46];
      const RADIO_CIUDAD = ["interpolate", ["linear"], ["get", "count"], 1, 11, 1000, 15, 20000, 22, 200000, 32];
      const TXT = (size) => ({ "text-font": ["Open Sans Bold"], "text-size": size, "text-allow-overlap": true });
      const TXT_PAINT = { "text-color": ORO_BORDE };
      const opa = (...stops) => ["interpolate", ["linear"], ["zoom"], ...stops];

      // ── Tier 1: PAÍS (mundo). Fade out ~4→4.8 ──
      const fadePais = opa(0, 0.96, 4, 0.96, 4.8, 0);
      map.addLayer({ id: "pais-badge", type: "circle", source: "paises",
        paint: { "circle-color": ORO, "circle-stroke-color": ORO_BORDE, "circle-stroke-width": 2,
          "circle-radius": RADIO_PAIS, "circle-opacity": fadePais, "circle-stroke-opacity": fadePais } });
      map.addLayer({ id: "pais-count", type: "symbol", source: "paises",
        layout: { "text-field": fmt("count"), ...TXT(["interpolate", ["linear"], ["get", "count"], 1, 11, 50000, 14, 500000, 18]) },
        paint: { ...TXT_PAINT, "text-opacity": fadePais } });
      map.addLayer({ id: "pais-nombre", type: "symbol", source: "paises",
        layout: { "text-field": ["get", "nombre"], "text-font": ["Open Sans Bold"], "text-size": 12,
          "text-offset": [0, 1.5], "text-anchor": "top", "text-allow-overlap": false, "text-optional": true },
        paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.4, "text-opacity": fadePais } });

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

      // ── Tier 3: BANDERA por ciudad. Fade in ~7.8→8.6. Tamaño por zoom × cantidad.
      // (zoom debe ser top-level en el interpolate; el factor por cantidad va en las salidas) ──
      const cf = ["interpolate", ["linear"], ["get", "count"], 1, 0.7, 1000, 1.0, 50000, 1.5, 300000, 2.0];
      map.addLayer({ id: "ciudad-flag", type: "symbol", source: "ciudades", filter: ["!", ["has", "point_count"]],
        layout: { "icon-image": "bandera", "icon-allow-overlap": true, "icon-anchor": "bottom",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 8, ["*", 0.3, cf], 12, ["*", 0.62, cf], 16, ["*", 0.85, cf]],
          "text-field": ["get", "ciudad"], "text-font": ["Open Sans Bold"], "text-size": 11,
          "text-offset": [0, 0.7], "text-anchor": "top", "text-optional": true, "text-allow-overlap": false },
        paint: { "icon-opacity": opa(7.8, 0, 8.6, 1), "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3, "text-opacity": opa(8.2, 0, 9, 1) } });

      // ── Tier 4: CASAS opt-in (punto exacto). Solo a zoom alto ──
      if (opts.flagsUrl) {
        map.addSource("casas", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "casas", type: "symbol", source: "casas",
          layout: { "icon-image": "bandera", "icon-allow-overlap": true, "icon-anchor": "bottom",
            "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.32, 13, 0.55, 17, 0.8],
            "text-field": ["get", "nombre"], "text-font": ["Open Sans Bold"], "text-size": 11,
            "text-offset": [0, 0.7], "text-anchor": "top", "text-optional": true, "text-allow-overlap": false },
          paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3 } });
        map.on("click", "casas", (e) => {
          const f = e.features[0], p = f.properties;
          popupEn(f.geometry.coordinates.slice(), `<strong>🚩 ${p.nombre || "Un Olimpista"}</strong><span>${p.ciudad || ""}</span>`);
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
      if (pendPaises && map.getSource("paises")) map.getSource("paises").setData(buildFC(pendPaises));
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
        if (ready && map.getSource("paises")) map.getSource("paises").setData(buildFC(pendPaises));
        return this;
      },
      pov(p) { if (p) map.flyTo({ center: [p.lng, p.lat], zoom: p.zoom != null ? p.zoom : 2.4, duration: 1600 }); return this; },
      stopRotation() { girando = false; return this; },
      raw: map,
    };
  }

  return { create };
})();
