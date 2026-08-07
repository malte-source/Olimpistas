"use strict";
/**
 * lib/edad.js — Tier por edad.
 * Menor de 18 → Junior (slug "kids"). 18 o más → Plus (slug "premium").
 * Aplica tanto a socios validados (incluido) como a no socios (pago).
 */
const MAYORIA = 18;

function edadDesde(fechaNac) {
  if (!fechaNac) return null;
  const d = new Date(fechaNac);
  if (isNaN(d.getTime())) return null;
  const hoy = new Date();
  let edad = hoy.getUTCFullYear() - d.getUTCFullYear();
  const m = hoy.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && hoy.getUTCDate() < d.getUTCDate())) edad--;
  return edad;
}

/** "kids" (<18) | "premium" (>=18) | null (sin fecha válida). */
function tierPorEdad(fechaNac) {
  const e = edadDesde(fechaNac);
  if (e == null || e < 0 || e > 120) return null;
  return e < MAYORIA ? "kids" : "premium";
}

module.exports = { edadDesde, tierPorEdad, MAYORIA };
