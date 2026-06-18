/* globe.js — globo 3D con MapLibre GL (satélite, zoom real tipo Google Maps).
   Banderas de Olimpia por ciudad con CLUSTERING nativo: de lejos se ven racimos
   (badge dorado con el total de Olimpistas), y al acercar se abren en banderas
   que escalan con el zoom. Interfaz OLI_GLOBE:
   create(el, {onFlagClick, onPick, autoRotate, zoom, center}) → {setData, pov, stopRotation, raw}. */
window.OLI_GLOBE = (function () {
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

  const SRC = "olimpistas";
  const lugarDe = (d) => (d.ciudad ? `${d.ciudad}, ${d.pais || ""}` : (d.pais || d.nombre || ""));

  function buildFC(points) {
    return {
      type: "FeatureCollection",
      features: (points || []).filter((d) => d.lat != null && d.lng != null).map((d) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [Number(d.lng), Number(d.lat)] },
        properties: { ciudad: d.ciudad || "", pais: d.pais || d.nombre || "", count: Number(d.count || 1) },
      })),
    };
  }

  function create(el, opts = {}) {
    const ML = window.maplibregl;
    if (!ML || !el) return null;

    const map = new ML.Map({
      container: el,
      style: ESTILO,
      center: opts.center || [-58.4, -23.4],
      zoom: opts.zoom != null ? opts.zoom : 1.6,
      attributionControl: { compact: true },
      dragRotate: true,
    });
    map.addControl(new ML.NavigationControl({ showCompass: false }), "top-right");

    // Rotación automática: pausa al interactuar, reanuda tras inactividad. Solo a zoom bajo.
    let girando = opts.autoRotate !== false;
    let idle = null;
    const SEG_POR_VUELTA = 140;
    function girar() {
      if (!girando) return;
      if (map.getZoom() < 4) {
        const c = map.getCenter();
        c.lng -= 360 / SEG_POR_VUELTA * 1.2;
        map.easeTo({ center: c, duration: 1200, easing: (t) => t });
      }
    }
    map.on("moveend", girar);
    if (opts.autoRotate !== false) {
      const pausar = () => {
        girando = false;
        clearTimeout(idle);
        idle = setTimeout(() => { girando = true; girar(); }, opts.reanudarMs || 4000);
      };
      ["mousedown", "touchstart", "wheel", "drag"].forEach((ev) => map.on(ev, pausar));
    }

    let popup = null;
    let ready = false;
    let pending = null;

    // Carga la bandera SVG como imagen del mapa (para la capa de símbolos).
    function cargarIconoBandera() {
      return new Promise((res) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          const w = 110, h = Math.round(w * ((img.height / img.width) || 0.72));
          const c = document.createElement("canvas"); c.width = w * 2; c.height = h * 2;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, w * 2, h * 2);
          try { if (!map.hasImage("bandera")) map.addImage("bandera", ctx.getImageData(0, 0, w * 2, h * 2), { pixelRatio: 2 }); } catch (e) {}
          res();
        };
        img.onerror = () => res();
        img.src = "/assets/flag-olimpia.svg?v=4";
      });
    }

    function addLayers() {
      if (map.getSource(SRC)) return;
      map.addSource(SRC, {
        type: "geojson",
        data: buildFC(pending || []),
        cluster: true,
        clusterMaxZoom: 7,
        clusterRadius: 50,
        clusterProperties: { sum: ["+", ["get", "count"]] }, // suma de Olimpistas por racimo
      });

      // Racimo: badge dorado, radio según cantidad de Olimpistas.
      map.addLayer({
        id: "clusters", type: "circle", source: SRC, filter: ["has", "point_count"],
        paint: {
          "circle-color": "#c9a227",
          "circle-stroke-color": "#1a1500",
          "circle-stroke-width": 2,
          "circle-opacity": 0.96,
          "circle-radius": ["step", ["get", "sum"], 15, 1000, 20, 10000, 28, 60000, 38],
        },
      });
      // Total del racimo, abreviado (97K, 2K, 540…).
      map.addLayer({
        id: "clusters-count", type: "symbol", source: SRC, filter: ["has", "point_count"],
        layout: {
          "text-field": ["case",
            [">=", ["get", "sum"], 1000],
            ["concat", ["to-string", ["round", ["/", ["get", "sum"], 1000]]], "K"],
            ["to-string", ["get", "sum"]]],
          "text-font": ["Open Sans Bold"],
          "text-size": ["step", ["get", "sum"], 11, 10000, 14],
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#1a1500" },
      });
      // Banderas individuales (ciudades sueltas), escaladas por zoom.
      map.addLayer({
        id: "banderas", type: "symbol", source: SRC, filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": "bandera",
          "icon-allow-overlap": true,
          "icon-anchor": "bottom",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.13, 4, 0.22, 6, 0.34, 9, 0.52, 12, 0.7],
        },
      });

      // Click en racimo → acercar (lo expande).
      map.on("click", "clusters", (e) => {
        const f = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
        if (!f) return;
        map.getSource(SRC).getClusterExpansionZoom(f.properties.cluster_id)
          .then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: Math.max(z, map.getZoom() + 1.5), duration: 900 }))
          .catch(() => {});
      });
      // Click en bandera → popup ciudad + total.
      map.on("click", "banderas", (e) => {
        const f = e.features[0]; const p = f.properties; const coords = f.geometry.coordinates.slice();
        if (opts.onFlagClick) opts.onFlagClick({ ciudad: p.ciudad, pais: p.pais, count: p.count, lng: coords[0], lat: coords[1] });
        if (popup) popup.remove();
        popup = new ML.Popup({ offset: 16, closeButton: false })
          .setLngLat(coords)
          .setHTML(`<strong>${lugarDe(p)}</strong><span>${Number(p.count || 1).toLocaleString("es-PY")} Olimpista${(p.count || 1) === 1 ? "" : "s"}</span>`)
          .addTo(map);
      });
      ["clusters", "banderas"].forEach((id) => {
        map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
      });
    }

    map.once("load", async () => {
      try { map.setSky({ "sky-color": "#0b0b0f", "horizon-color": "#1a1a22", "fog-color": "#0b0b0f", "fog-ground-blend": 0.4 }); } catch (e) {}
      await cargarIconoBandera();
      addLayers();
      ready = true;
      if (pending && map.getSource(SRC)) map.getSource(SRC).setData(buildFC(pending));
      girar();
    });

    // onPick: elegir ubicación (usado en el perfil). No dispara sobre racimos/banderas.
    if (opts.onPick) {
      map.on("click", (e) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: ["clusters", "banderas"].filter((l) => map.getLayer(l)) });
        if (hit.length) return;
        opts.onPick(e.lngLat.lat, e.lngLat.lng);
      });
    }

    return {
      setData(points) {
        pending = points || [];
        if (ready && map.getSource(SRC)) map.getSource(SRC).setData(buildFC(pending));
        return this;
      },
      pov(p) {
        if (p) map.flyTo({ center: [p.lng, p.lat], zoom: p.zoom != null ? p.zoom : 2.4, duration: 1600 });
        return this;
      },
      stopRotation() { girando = false; return this; },
      raw: map,
    };
  }

  return { create };
})();
