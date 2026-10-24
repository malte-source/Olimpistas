"use strict";
/**
 * lib/push.js — notificaciones push (Web Push) de Olimpistas.
 *
 * Cuatro tipos de aviso, cada persona elige cuáles quiere (todos activos al suscribirse):
 *   subasta    te superaron en una subasta
 *   pago       se vence tu plazo para pagar un lote
 *   beneficio  beneficio nuevo o destacado en tu ciudad (máximo uno por día)
 *   partido    aviso del club (partido de hoy, etc.), lo envía el equipo desde el panel
 *
 * Necesita VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY (Secret Manager). Sin ellas el módulo queda apagado y nada falla.
 * Una suscripción que el navegador ya no reconoce (404/410) se borra sola.
 */
const log = require("./log");

const TIPOS = ["subasta", "pago", "beneficio", "partido"];
const habilitado = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
const clavePublica = () => process.env.VAPID_PUBLIC_KEY || "";

let _wp = null;
function webpush() {
  if (_wp) return _wp;
  _wp = require("web-push");
  _wp.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:malte@thecrewagencia.com", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  return _wp;
}

/** Preferencias efectivas: todo activo salvo lo que la persona apagó. */
function prefsDe(socio) {
  let p = socio && socio.push_prefs;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch (e) { p = null; } }
  const out = {};
  for (const t of TIPOS) out[t] = !(p && p[t] === false);
  return out;
}

/** El aviso solo puede llevar a una página de Olimpistas (nunca a un sitio de afuera). */
function urlSegura(u, base) {
  const b = String(base || "").replace(/\/$/, "");
  const s = String(u || "");
  if (s.startsWith("/") && !s.startsWith("//")) return b + s;
  try { const x = new URL(s); if (b && x.origin === new URL(b).origin) return x.toString(); } catch (e) { /* inválida */ }
  return b + "/miembro";
}

const recorta = (t, n) => String(t == null ? "" : t).replace(/\s+/g, " ").trim().slice(0, n);

function armar(payload, base) {
  return JSON.stringify({
    titulo: recorta(payload.titulo, 80) || "Olimpistas",
    cuerpo: recorta(payload.cuerpo, 160),
    url: urlSegura(payload.url, base),
    tag: recorta(payload.tag, 60) || undefined,
    tipo: TIPOS.includes(payload.tipo) ? payload.tipo : undefined,
  });
}

async function mandar(store, sub, cuerpo, sender) {
  try {
    await (sender || ((s, c) => webpush().sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, c, { TTL: 6 * 3600, urgency: "normal" })))(sub, cuerpo);
    return true;
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) { if (store.borrarPushSuscripcion) store.borrarPushSuscripcion(sub.endpoint).catch(() => {}); }
    else log.warn({ status: e && e.statusCode, err: String(e && e.message).slice(0, 120) }, "push: no se pudo enviar");
    return false;
  }
}

/** Aviso a UNA persona. Devuelve cuántos dispositivos lo recibieron. */
async function avisar(store, socioId, tipo, payload, { base, sender } = {}) {
  if (!TIPOS.includes(tipo) || (!habilitado() && !sender) || !store.listarPushDeSocio) return 0;
  try {
    const [socio, subs] = await Promise.all([store.getSocioById(socioId), store.listarPushDeSocio(socioId)]);
    if (!socio || !subs.length || !prefsDe(socio)[tipo]) return 0;
    const cuerpo = armar({ ...payload, tipo }, base);
    let n = 0;
    for (const s of subs) if (await mandar(store, s, cuerpo, sender)) n++;
    return n;
  } catch (e) { log.warn({ err: String(e && e.message).slice(0, 120) }, "push: aviso falló"); return 0; }
}

/**
 * Aviso a muchas personas (opcionalmente solo de una ciudad). Respeta sus preferencias; para "beneficio" y "partido"
 * cada persona recibe como máximo uno por día (reservarNotificacion es atómico y evita repetidos si el proceso se repite).
 * Tope de seguridad: 2.000 dispositivos por difusión.
 */
async function difundir(store, { tipo, ciudad, payload, base, sender, tope = 2000, clave }) {
  if (!TIPOS.includes(tipo) || (!habilitado() && !sender) || !store.listarPushDifusion) return { destinatarios: 0, enviados: 0 };
  const hoy = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const filas = await store.listarPushDifusion({ ciudad, limit: tope });
  const cuerpo = armar({ ...payload, tipo }, base);
  const vistos = new Set(), omitidos = new Set();
  let destinatarios = 0, enviados = 0;
  for (const f of filas) {
    if (!prefsDe(f)[tipo]) continue;
    if (!vistos.has(f.socio_id)) {
      vistos.add(f.socio_id);
      if (store.reservarNotificacion && !(await store.reservarNotificacion(`push:${tipo}:${f.socio_id}:${hoy}${clave ? ":" + clave : ""}`))) omitidos.add(f.socio_id);
      else destinatarios++;
    }
    if (omitidos.has(f.socio_id)) continue;
    if (await mandar(store, f, cuerpo, sender)) enviados++;
  }
  return { destinatarios, enviados };
}

module.exports = { TIPOS, habilitado, clavePublica, prefsDe, urlSegura, armar, avisar, difundir };
