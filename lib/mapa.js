"use strict";
/**
 * lib/mapa.js — historia del mapa: altas acumuladas por mes y por país (solo hinchas reales).
 * Alimenta el deslizador "Mirá cómo crece" del globo. Son totales por país, nunca datos de una persona.
 */

/** filas: [{mes:'2026-05', iso:'PY', n}] → [{mes, total, porPais:{PY:n}}] acumulado, sin huecos hasta el mes actual. */
function acumularHistoria(filas, ahora = new Date()) {
  const porMes = new Map();
  for (const f of filas || []) {
    const mes = String(f.mes || ""), iso = String(f.iso || "").toUpperCase(), n = Number(f.n) || 0;
    if (!/^\d{4}-\d{2}$/.test(mes) || !/^[A-Z]{2}$/.test(iso) || n <= 0) continue;
    if (!porMes.has(mes)) porMes.set(mes, {});
    porMes.get(mes)[iso] = (porMes.get(mes)[iso] || 0) + n;
  }
  const meses = [...porMes.keys()].sort();
  if (!meses.length) return [];
  const actual = `${ahora.getUTCFullYear()}-${String(ahora.getUTCMonth() + 1).padStart(2, "0")}`;
  const ultimo = meses[meses.length - 1] > actual ? meses[meses.length - 1] : actual;
  const out = [], acum = {};
  let [y, m] = meses[0].split("-").map(Number);
  for (;;) {
    const clave = `${y}-${String(m).padStart(2, "0")}`;
    for (const [iso, n] of Object.entries(porMes.get(clave) || {})) acum[iso] = (acum[iso] || 0) + n;
    out.push({ mes: clave, total: Object.values(acum).reduce((a, b) => a + b, 0), porPais: { ...acum } });
    if (clave === ultimo) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

module.exports = { acumularHistoria };
