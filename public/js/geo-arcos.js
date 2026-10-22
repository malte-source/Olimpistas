/* geo-arcos.js — arcos de círculo máximo (el camino más corto sobre la esfera) para "Todos los caminos llevan al Defensores".
   Sin librerías: interpolación esférica (slerp). Sirve en el navegador (window.OLI_GEO) y en Node (para las pruebas). */
(function (raiz) {
  const R = Math.PI / 180;
  const DEFENSORES = [-57.6136, -25.2925]; // [lng, lat] — Estadio Defensores del Chaco, Asunción

  // Puntos [lng, lat] a lo largo del camino más corto entre dos puntos. Si el camino cruza el antimeridiano se corta en tramos.
  function arco(desde, hasta, pasos = 48) {
    const [lng1, lat1] = [desde[0] * R, desde[1] * R], [lng2, lat2] = [hasta[0] * R, hasta[1] * R];
    const v1 = [Math.cos(lat1) * Math.cos(lng1), Math.cos(lat1) * Math.sin(lng1), Math.sin(lat1)];
    const v2 = [Math.cos(lat2) * Math.cos(lng2), Math.cos(lat2) * Math.sin(lng2), Math.sin(lat2)];
    const dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
    const d = Math.acos(dot);
    if (d < 1e-9) return [[desde.slice()]];
    const tramos = [[]];
    let prev = null;
    for (let i = 0; i <= pasos; i++) {
      const t = i / pasos, a = Math.sin((1 - t) * d) / Math.sin(d), b = Math.sin(t * d) / Math.sin(d);
      const x = a * v1[0] + b * v2[0], y = a * v1[1] + b * v2[1], z = a * v1[2] + b * v2[2];
      const lng = Math.atan2(y, x) / R, lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / R;
      if (prev !== null && Math.abs(lng - prev) > 180) tramos.push([]);
      tramos[tramos.length - 1].push([lng, lat]);
      prev = lng;
    }
    return tramos;
  }

  /** paises: [{iso, lat, lng, count}] → FeatureCollection de líneas hacia el estadio (Paraguay no dibuja: ya está ahí). */
  function caminosFC(paises, destino = DEFENSORES) {
    const features = [];
    for (const p of paises || []) {
      if (p.lat == null || p.lng == null || String(p.iso || "").toUpperCase() === "PY") continue;
      const tramos = arco([Number(p.lng), Number(p.lat)], destino).filter((t) => t.length > 1);
      if (!tramos.length) continue;
      features.push({ type: "Feature", properties: { iso: p.iso || "", count: Number(p.count || 1) },
        geometry: tramos.length === 1 ? { type: "LineString", coordinates: tramos[0] } : { type: "MultiLineString", coordinates: tramos } });
    }
    return { type: "FeatureCollection", features };
  }

  const api = { arco, caminosFC, DEFENSORES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.OLI_GEO = api;
})(typeof window !== "undefined" ? window : globalThis);
