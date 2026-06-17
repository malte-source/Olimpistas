"use strict";

/**
 * lib/access.js — Reglas de acceso por nivel de membresía.
 *
 * Modelo simple y consistente: dos niveles.
 *   público (sin sesión / sin membresía) → -1
 *   Olimpista gratis                      →  0
 *   Olimpista Kids / Premium (pago)       →  1
 *
 * El nivel sale del catálogo de tiers (config.TIERS[].nivel), no de un mapa
 * aparte, así nunca se desincroniza con los precios/beneficios.
 */

const { tierBySlug } = require("../config");

/** Nivel del socio según su membresía activa (null = público = -1). */
function nivelDeMembresia(membresia) {
  if (!membresia) return -1;
  const tier = tierBySlug(membresia.tier_slug);
  return tier ? tier.nivel : -1;
}

/** Nivel mínimo requerido por un slug de tier (ej. contenido.tier_min). */
function nivelRequerido(tierMinSlug) {
  const tier = tierBySlug(tierMinSlug);
  return tier ? tier.nivel : 0;
}

/** ¿El socio (por su membresía) alcanza el nivel mínimo requerido? */
function puedeAcceder(membresia, tierMinSlug) {
  return nivelDeMembresia(membresia) >= nivelRequerido(tierMinSlug);
}

module.exports = { nivelDeMembresia, nivelRequerido, puedeAcceder };
