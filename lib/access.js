"use strict";

/**
 * lib/access.js — Reglas de acceso por nivel de membresía.
 *
 * Ranking para gatear contenido / sorteos / preventas:
 *   público (sin sesión)        → 0
 *   olimpista (gratis) / junior → 1
 *   plata                       → 2
 *   oro                         → 3
 */

const RANK = { olimpista: 1, junior: 1, plata: 2, oro: 3 };

/** Rank del socio según su membresía activa (null = público). */
function rankDeMembresia(membresia) {
  if (!membresia) return 0;
  return RANK[membresia.tier_slug] || 0;
}

/** ¿El socio (por su membresía) alcanza el nivel mínimo requerido? */
function puedeAcceder(membresia, tierMin) {
  return rankDeMembresia(membresia) >= (RANK[tierMin] || 1);
}

module.exports = { RANK, rankDeMembresia, puedeAcceder };
