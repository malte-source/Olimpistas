"use strict";
/**
 * lib/h3.js — barrios en hexágonos (H3) para el mapa público, con k-anonimato.
 *
 * Nunca se entrega una casa: se cuentan hinchas por celda H3 (res 9 ≈ 0,1 km², un barrio chico) y una celda solo se
 * muestra si tiene al menos K hinchas. Las celdas con menos se vuelven a agrupar un nivel más arriba (res 8); si el
 * grupo sigue por debajo de K, no se dibuja. Quien está solo en su zona no aparece, ni siquiera como celda.
 */
const h3 = require("h3-js");

const K = 3;
const RES = 9, RES_PADRE = 8;

/** puntos: [{lat,lng}] (solo hinchas que eligieron mostrarse) → [{c, n, r}] */
function celdasAnonimas(puntos) {
  const porCelda = new Map();
  for (const p of puntos) {
    const lat = Number(p.lat), lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const c = h3.latLngToCell(lat, lng, RES);
    porCelda.set(c, (porCelda.get(c) || 0) + 1);
  }
  const out = [];
  const chicas = new Map(); // padre → total de las celdas que no llegaron a K
  for (const [c, n] of porCelda) {
    if (n >= K) { out.push({ c, n, r: RES }); continue; }
    const padre = h3.cellToParent(c, RES_PADRE);
    chicas.set(padre, (chicas.get(padre) || 0) + n);
  }
  for (const [c, n] of chicas) if (n >= K) out.push({ c, n, r: RES_PADRE });
  return out;
}

/** Centro [lat, lng] de una celda H3. */
const centro = (c) => h3.cellToLatLng(c);

module.exports = { celdasAnonimas, centro, K, RES, RES_PADRE };
