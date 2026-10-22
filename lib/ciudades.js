"use strict";
/**
 * lib/ciudades.js — ciudades normalizadas (GeoNames cities15000.txt, CC-BY 4.0 · https://www.geonames.org).
 * Texto del archivo → filas; normalización para buscar sin acentos ni mayúsculas; distancia entre puntos.
 */

const norm = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Una línea de cities15000.txt (TSV) → fila, o null si no sirve. Columnas: 0 id, 1 nombre, 2 ascii, 4 lat, 5 lng, 8 país, 14 población. */
function filaDeGeonames(linea) {
  const c = String(linea).replace(/\r$/, "").split("\t");
  if (c.length < 15) return null;
  const id = Number(c[0]), lat = Number(c[4]), lng = Number(c[5]), poblacion = Number(c[14]) || 0;
  const pais = String(c[8] || "").toUpperCase();
  if (!Number.isInteger(id) || !Number.isFinite(lat) || !Number.isFinite(lng) || !/^[A-Z]{2}$/.test(pais) || !c[1]) return null;
  // Se busca por el nombre sin acentos ni mayúsculas (así "Nemby" y "Ñemby" son lo mismo, y "Asuncion" encuentra "Asunción").
  return { id, nombre: c[1], nombre_norm: norm(c[1]), pais_iso: pais, lat, lng, poblacion };
}
function parsearGeonames(texto) { const out = []; for (const l of String(texto).split("\n")) { if (!l.trim()) continue; const f = filaDeGeonames(l); if (f) out.push(f); } return out; }

const R_TIERRA = 6371;
function distanciaKm(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R_TIERRA * Math.asin(Math.min(1, Math.sqrt(a)));
}

module.exports = { norm, filaDeGeonames, parsearGeonames, distanciaKm };
