/* globe.js — globo 3D reutilizable (landing: banderas / perfil: elegir punto).
   Requiere /assets/vendor/globe.gl.min.js (expone window.Globe). */
window.OLI_GLOBE = (function () {
  function flagEl(d, base) {
    const wrap = document.createElement("div");
    const size = base + Math.min(30, Math.log2((d.count || 1) + 1) * 6);
    const lugar = d.ciudad ? `${d.ciudad}, ${d.pais || ""}` : (d.pais || d.nombre || "");
    // Doble sombra (oscura + halo claro) para que el franjeado blanco/negro se lea
    // sobre cualquier fondo (mar azul, tierra o espacio oscuro).
    wrap.innerHTML = `<img src="/assets/flag-olimpia.svg?v=3" alt="" style="width:${size}px;height:auto;filter:drop-shadow(0 1px 2px rgba(0,0,0,.75)) drop-shadow(0 0 2px rgba(255,255,255,.45))" />`;
    wrap.style.cursor = "pointer";
    wrap.style.transform = "translate(-10%, -90%)";
    wrap.title = lugar ? `${lugar} · ${Number(d.count || 0).toLocaleString("es-PY")}` : "";
    return wrap;
  }

  function create(el, opts = {}) {
    const Globe = window.Globe;
    if (!Globe || !el) return null;

    const g = Globe()(el)
      .globeImageUrl(opts.imageUrl || "/assets/earth-blue-marble.jpg")
      .bumpImageUrl("/assets/earth-topology.png")
      .backgroundColor("rgba(0,0,0,0)")
      .showAtmosphere(true).atmosphereColor("#c9a227").atmosphereAltitude(0.22)
      .showGraticules(opts.graticules !== false)
      .htmlElementsData([])
      .htmlLat("lat").htmlLng("lng").htmlAltitude(0.012)
      .htmlElement((d) => {
        const node = flagEl(d, opts.flagBase || 16);
        node.onclick = (e) => { e.stopPropagation(); opts.onFlagClick && opts.onFlagClick(d); };
        return node;
      });

    const ctrl = g.controls();
    ctrl.autoRotate = opts.autoRotate !== false;
    ctrl.autoRotateSpeed = opts.rotateSpeed != null ? opts.rotateSpeed : 0.45;
    ctrl.enableZoom = opts.zoom !== false;

    if (opts.onPick) g.onGlobeClick(({ lat, lng }) => opts.onPick(lat, lng));

    const resize = () => {
      const w = el.clientWidth || 320;
      const h = Math.min(opts.maxH || 560, Math.max(320, Math.round(w * (opts.ratio || 0.85))));
      g.width(w).height(h);
    };
    resize();
    window.addEventListener("resize", resize);

    return {
      setData(points) { g.htmlElementsData(points || []); return this; },
      pov(p, ms) { g.pointOfView(p, ms == null ? 900 : ms); return this; },
      stopRotation() { g.controls().autoRotate = false; return this; },
      raw: g,
    };
  }

  return { create };
})();
