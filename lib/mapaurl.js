"use strict";
/**
 * lib/mapaurl.js — de un link de Google Maps a coordenadas, para ubicar un comercio sin escribir números.
 *
 * El club pega el link que comparte Google Maps (corto `maps.app.goo.gl/…` o largo `google.com/maps/…`) y el servidor lo
 * convierte en lat/lng. Los links cortos se siguen a mano, sin abrir nada más que Google: solo se aceptan hosts de Google
 * y como mucho 4 saltos (así no se puede usar para hacer que el servidor pida cualquier dirección).
 */

const HOST_OK = /^(www\.)?(maps\.)?(google\.[a-z.]{2,6}|goo\.gl|maps\.app\.goo\.gl)$/i;
const dentro = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

/** Busca coordenadas en un texto: primero el punto del lugar (!3d…!4d…), después el centro del mapa (@lat,lng) y q=/ll=, y "lat,lng" a secas. */
function coordsDeTexto(t) {
  const s = decodeURIComponent(String(t || "").replace(/%(?![0-9a-f]{2})/gi, "%25"));
  const pats = [/!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/, /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/, /[?&](?:q|ll|query|center)=(-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/, /^\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/];
  for (const re of pats) { const m = s.match(re); if (m) { const lat = Number(m[1]), lng = Number(m[2]); if (dentro(lat, lng)) return { lat, lng }; } }
  return null;
}

/** Igual que coordsDeTexto pero también sigue links cortos de Google (hasta 4 redirecciones, solo hosts de Google). */
async function resolver(entrada, fetchFn = fetch) {
  const directo = coordsDeTexto(entrada);
  if (directo) return directo;
  let actual = String(entrada || "").trim();
  for (let i = 0; i < 4; i++) {
    let u; try { u = new URL(actual); } catch (e) { return null; }
    if (u.protocol !== "https:" || !HOST_OK.test(u.hostname)) return null;
    const c = coordsDeTexto(u.href); if (c) return c;
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 6000);
    let r; try { r = await fetchFn(u.href, { redirect: "manual", signal: ac.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; Olimpistas/1.0)" } }); } catch (e) { return null; } finally { clearTimeout(t); }
    const loc = r && r.headers && r.headers.get && r.headers.get("location");
    if (!loc) return null;
    actual = new URL(loc, u.href).href;
  }
  return coordsDeTexto(actual);
}

module.exports = { coordsDeTexto, resolver, HOST_OK };
