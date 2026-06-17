/* globe.js — globo 3D reutilizable (landing: display de banderas / perfil: elegir punto).
   Requiere /assets/vendor/globe.gl.min.js cargado antes (expone window.Globe). */
window.OLI_GLOBE = (function () {
  function flagEl(d, base) {
    const wrap = document.createElement("div");
    const size = base + Math.min(26, Math.log2((d.count || 1) + 1) * 5);
    wrap.innerHTML = `<img src="/assets/flag-olimpia.svg" alt="" style="width:${size}px;height:auto;filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))" />`;
    wrap.style.cursor = "pointer";
    wrap.style.transform = "translate(-10%, -90%)"; // que el mástil "apoye" en el punto
    wrap.title = d.nombre ? `${d.nombre}: ${Number(d.count || 0).toLocaleString("es-PY")}` : "";
    return wrap;
  }

  function create(el, opts = {}) {
    const Globe = window.Globe;
    if (!Globe || !el) return null;

    const g = Globe()(el)
      .globeImageUrl("/assets/earth-dark.jpg")
      .backgroundColor("rgba(0,0,0,0)")
      .showAtmosphere(true).atmosphereColor("#c9a227").atmosphereAltitude(0.16)
      .htmlElementsData([])
      .htmlLat("lat").htmlLng("lng").htmlAltitude(0.012)
      .htmlElement((d) => {
        const node = flagEl(d, opts.flagBase || 14);
        node.onclick = (e) => { e.stopPropagation(); opts.onFlagClick && opts.onFlagClick(d); };
        return node;
      });

    const ctrl = g.controls();
    ctrl.autoRotate = opts.autoRotate !== false;
    ctrl.autoRotateSpeed = opts.rotateSpeed || 0.5;
    ctrl.enableZoom = opts.zoom !== false;

    if (opts.onPick) g.onGlobeClick(({ lat, lng }) => opts.onPick(lat, lng));

    const resize = () => {
      const w = el.clientWidth || 320;
      g.width(w).height(Math.min(opts.maxH || 520, Math.max(300, Math.round(w * 0.8))));
    };
    resize();
    window.addEventListener("resize", resize);

    return {
      setData(points) { g.htmlElementsData(points || []); return this; },
      pov(p, ms) { g.pointOfView(p, ms == null ? 800 : ms); return this; },
      stopRotation() { g.controls().autoRotate = false; return this; },
      raw: g,
    };
  }

  return { create };
})();
