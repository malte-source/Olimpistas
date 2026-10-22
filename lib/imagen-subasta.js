"use strict";

/**
 * lib/imagen-subasta.js — la foto de una subasta como recurso aparte, cacheable.
 *
 * La foto se guarda en la columna `subastas.imagen` como data URL base64 (116–156 KB por
 * lote). Mandarla dentro del JSON de /api/subastas hacía que la home bajara ~300 KB de
 * imágenes en cada visita (el 67 % de la carga) y no se podía cachear porque iba mezclada
 * con precios que cambian cada segundo. Ahora el JSON trae solo `imagen_url` (con un hash
 * del contenido como `?v=`) y el navegador baja la foto una vez, con caché inmutable.
 */
const crypto = require("crypto");

const TIPOS = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const RE_DATA = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i;
const RE_HTTP = /^https?:\/\//i;

const versionImagen = (imagen) => crypto.createHash("md5").update(String(imagen || "")).digest("hex").slice(0, 10);

// Acepta la fila completa (con `imagen`) o la liviana (con `tiene_imagen` + `imagen_v`).
function urlImagen(s) {
  if (!s) return null;
  if (typeof s.imagen === "string" && RE_HTTP.test(s.imagen)) return s.imagen;
  const tiene = s.tiene_imagen !== undefined ? !!s.tiene_imagen : !!s.imagen;
  if (!tiene) return null;
  const v = s.imagen_v || versionImagen(s.imagen);
  return `/api/subastas/${encodeURIComponent(s.slug || s.id)}/imagen?v=${v}`;
}

// Solo rasters: un SVG subido por el admin podría llevar scripts. Devuelve null si no es válida.
function decodificar(imagen) {
  const m = RE_DATA.exec(String(imagen || ""));
  if (!m) return null;
  const tipo = m[1].toLowerCase();
  if (!TIPOS[tipo]) return null;
  return { tipo, buf: Buffer.from(m[2].replace(/\s+/g, ""), "base64") };
}

// Handler de GET /api/subastas/:id/imagen. Se monta ANTES de attachSocio (no necesita sesión).
function servirImagen(getStore) {
  // Cache de decodificados por instancia: evita releer 150 KB de la DB por cada miss del navegador.
  const cache = new Map();
  const TTL = 5 * 60 * 1000, MAX = 30;
  return async function (req, res) {
    const ref = String(req.params.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
    if (!ref) return res.status(404).end();
    try {
      let e = cache.get(ref);
      if (!e || Date.now() - e.t > TTL) {
        const fila = await getStore().imagenSubasta(ref);
        if (!fila || !fila.imagen) return res.status(404).end();
        if (RE_HTTP.test(fila.imagen)) e = { t: Date.now(), url: fila.imagen };
        else {
          const d = decodificar(fila.imagen);
          if (!d) return res.status(404).end();
          e = { t: Date.now(), ...d };
        }
        if (cache.size >= MAX) cache.delete(cache.keys().next().value);
        cache.set(ref, e);
      }
      // Con ?v=<hash> la URL cambia si cambia la foto → se puede cachear "para siempre".
      res.setHeader("Cache-Control", req.query.v ? "public, max-age=31536000, immutable" : "public, max-age=300");
      if (e.url) return res.redirect(302, e.url);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.type(e.tipo).send(e.buf);
    } catch (err) {
      res.status(503).setHeader("Retry-After", "5");
      res.end();
    }
  };
}

module.exports = { urlImagen, versionImagen, decodificar, servirImagen };
