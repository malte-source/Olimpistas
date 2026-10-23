"use strict";

/**
 * lib/access.js — Reglas de acceso por nivel de membresía.
 *
 * Modelo simple y consistente, escalonado:
 *   público (sin sesión / sin membresía) → -1
 *   Olimpista gratis                      →  0
 *   Olimpista Junior (pago)               →  1
 *   Olimpista Plus (pago)                 →  2  → desbloquea todo lo de Junior + lo Plus
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

/** ¿Un hincha de ese tier puede usar un beneficio publicado para `niveles` ("todos" o lista de slugs)? Escalonado: un tier alto alcanza lo de los de abajo. */
function nivelAplica(tierSlug, niveles) {
  if (niveles === "todos" || niveles == null || niveles === "") return true;
  const lista = (Array.isArray(niveles) ? niveles : String(niveles).split(",")).map((x) => String(x).trim()).filter(Boolean);
  if (!lista.length) return true;
  const minimo = Math.min(...lista.map(nivelRequerido));
  const tier = tierBySlug(tierSlug);
  return (tier ? tier.nivel : 0) >= minimo;
}

module.exports = { nivelDeMembresia, nivelRequerido, puedeAcceder, nivelAplica };
