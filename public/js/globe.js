/* globe.js — mapa/globo 3D con MapLibre GL (satélite, zoom real tipo Google Maps).
   Requiere /assets/vendor/maplibre-gl.js (+ css). Mantiene la interfaz OLI_GLOBE:
   create(el, {onFlagClick, onPick, autoRotate, zoom, center, maxH}) → {setData, pov, raw}. */
window.OLI_GLOBE = (function () {
  // Estilo satelital (Esri World Imagery) + nombres/límites, proyección globo. Sin API key.
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

  function flagMarkup(d) {
    const size = 22 + Math.min(26, Math.log2((d.count || 1) + 1) * 5);
    return `<img src="/assets/flag-olimpia.svg?v=4" alt="" style="width:${size}px;height:auto;filter:drop-shadow(0 1px 2px rgba(0,0,0,.8)) drop-shadow(0 0 2px rgba(255,255,255,.5))" />`;
  }
  const lugarDe = (d) => (d.ciudad ? `${d.ciudad}, ${d.pais || ""}` : (d.pais || d.nombre || ""));

  function create(el, opts = {}) {
    const ML = window.maplibregl;
    if (!ML || !el) return null;
    // La altura del contenedor la define el CSS (responsive). MapLibre la toma de ahí.

    const map = new ML.Map({
      container: el,
      style: ESTILO,
      center: opts.center || [-58.4, -23.4],
      zoom: opts.zoom != null ? opts.zoom : 1.6,
      attributionControl: { compact: true },
      dragRotate: true,
    });
    map.addControl(new ML.NavigationControl({ showCompass: false }), "top-right");

    // Rotación automática del globo (se frena al interactuar) — patrón estándar.
    let girando = opts.autoRotate !== false;
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
    ["mousedown", "touchstart", "wheel"].forEach((ev) => map.on(ev, () => { girando = false; }));
    map.once("load", () => { try { map.setSky({ "sky-color": "#0b0b0f", "horizon-color": "#1a1a22", "fog-color": "#0b0b0f", "fog-ground-blend": 0.4 }); } catch (e) {} girar(); });

    if (opts.onPick) map.on("click", (e) => opts.onPick(e.lngLat.lat, e.lngLat.lng));

    let markers = [];
    let popup = null;
    return {
      setData(points) {
        markers.forEach((m) => m.remove()); markers = [];
        (points || []).forEach((d) => {
          if (d.lat == null || d.lng == null) return;
          const node = document.createElement("div");
          node.className = "mapa-flag";
          node.innerHTML = flagMarkup(d);
          node.style.cursor = "pointer";
          node.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (opts.onFlagClick) opts.onFlagClick(d);
            if (popup) popup.remove();
            popup = new ML.Popup({ offset: 22, closeButton: false })
              .setLngLat([d.lng, d.lat])
              .setHTML(`<strong>${lugarDe(d)}</strong><span>${Number(d.count || 1).toLocaleString("es-PY")} Olimpista${(d.count || 1) === 1 ? "" : "s"}</span>`)
              .addTo(map);
          });
          markers.push(new ML.Marker({ element: node, anchor: "bottom" }).setLngLat([d.lng, d.lat]).addTo(map));
        });
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
