"use strict";

/**
 * lib/geo.js — Detección del país del visitante.
 *
 * Orden de preferencia:
 *  1. Cabecera de país que inyecta el CDN/Load Balancer (lo más fiable en prod):
 *     cf-ipcountry (Cloudflare), x-appengine-country (Google), x-country-code.
 *  2. Geo-IP offline (fast-geoip) sobre la IP del cliente (X-Forwarded-For).
 *
 * Devuelve { iso, nombre, lat, lng } o null si no se pudo determinar.
 */

const geoip = require("fast-geoip");
const { paisCentroide, paisNombre } = require("../data/paises");

function clientIp(req) {
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || "";
}

function headerCountry(req) {
  const h = req.headers;
  // x-client-geo lo inyecta el Load Balancer de Google ({client_region}); el resto, otros CDNs.
  const c = h["x-client-geo"] || h["cf-ipcountry"] || h["x-appengine-country"] || h["x-country-code"];
  if (c && /^[A-Za-z]{2}$/.test(c) && c.toUpperCase() !== "XX" && c.toUpperCase() !== "ZZ") return c.toUpperCase();
  return null;
}

const esLocal = (ip) => !ip || /^(::1|127\.|::ffff:127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

async function detectarPais(req) {
  let iso = headerCountry(req);
  if (!iso) {
    const ip = clientIp(req);
    if (!esLocal(ip)) {
      try { const r = await geoip.lookup(ip); if (r && r.country) iso = r.country; }
      catch (e) { /* sin geo */ }
    }
  }
  if (!iso) return null;
  const c = paisCentroide(iso);
  return { iso, nombre: paisNombre(iso), lat: c ? c.lat : null, lng: c ? c.lng : null };
}

module.exports = { detectarPais, clientIp };
