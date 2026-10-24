"use strict";

/**
 * lib/carnet.js — QR rotativo del carnet (TOTP de 60 s firmado con HMAC).
 *
 * El hincha tiene un secreto propio (socios.carnet_secreto). Su QR dice
 *     OLI1.<socioId>.<ventana en base36>.<firma>
 * donde ventana = floor(epoch / 60 s) y firma = HMAC-SHA256(secreto, "<socioId>.<ventana>") (20 hex).
 * El comercio escanea, el servidor busca el secreto del hincha, recalcula la firma y acepta la ventana actual
 * y una a cada lado (±1: relojes desfasados y el momento de mostrar el QR). Una foto del QR deja de servir en
 * 2-3 minutos y, además, cada ventana se puede usar UNA vez (tabla carnet_usos).
 */
const crypto = require("crypto");

const VENTANA_S = 60;
const PREFIJO = "OLI1";
const RE_TOKEN = /^OLI1\.([A-Za-z0-9_-]{4,64})\.([0-9a-z]{1,10})\.([0-9a-f]{20})$/;

const ventanaDe = (ms = Date.now()) => Math.floor(ms / 1000 / VENTANA_S);
const firmaHex = (secreto, socioId, ventana) => crypto.createHmac("sha256", secreto).update(socioId + "." + ventana).digest("hex");
const codigoDe = (firma) => String(parseInt(firma.slice(20, 28), 16) % 1000000).padStart(6, "0");

function generarToken(socioId, secreto, ahora = Date.now()) {
  const ventana = ventanaDe(ahora), firma = firmaHex(secreto, socioId, ventana);
  const restoMs = (ventana + 1) * VENTANA_S * 1000 - ahora;
  return {
    token: `${PREFIJO}.${socioId}.${ventana.toString(36)}.${firma.slice(0, 20)}`,
    ventana,
    vence_en: Math.max(1, Math.ceil(restoMs / 1000)),          // segundos hasta que el QR "rota"
    codigo: codigoDe(firma),                                    // código corto: se ve junto al QR y sirve para dictarlo en caja si falla la cámara
  };
}

function parsearToken(token) {
  const m = RE_TOKEN.exec(String(token || "").trim());
  if (!m) return null;
  const ventana = parseInt(m[2], 36);
  if (!Number.isSafeInteger(ventana)) return null;
  return { socioId: m[1], ventana, firma: m[3] };
}

/**
 * Verifica un token. `obtenerSecreto(socioId)` devuelve el secreto del hincha (o null).
 * → { ok:true, socioId, ventana } | { ok:false, motivo: "formato" | "invalido" | "vencido" }
 * "invalido" cubre hincha desconocido y firma mala (no se distingue a propósito).
 */
async function verificarToken(token, obtenerSecreto, ahora = Date.now()) {
  const p = parsearToken(token);
  if (!p) return { ok: false, motivo: "formato" };
  const secreto = await obtenerSecreto(p.socioId);
  if (!secreto) return { ok: false, motivo: "invalido" };
  const esperada = Buffer.from(firmaHex(secreto, p.socioId, p.ventana).slice(0, 20));
  const recibida = Buffer.from(p.firma);
  if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return { ok: false, motivo: "invalido" };
  if (Math.abs(p.ventana - ventanaDe(ahora)) > 1) return { ok: false, motivo: "vencido" };
  return { ok: true, socioId: p.socioId, ventana: p.ventana };
}

/**
 * Verifica el código de 6 dígitos que se ve junto al QR (para cuando la cámara no lee). Es el mismo secreto y la misma ventana que el QR:
 * rota cada minuto, vale la ventana actual y una a cada lado, y se puede usar una sola vez por ventana. Sin el código de 6 dígitos el código fijo del socio
 * (que es público: va en su link de invitación) no alcanza para canjear.
 * → { ok:true, ventana } | { ok:false }
 */
function verificarCodigo(socioId, secreto, codigo, ahora = Date.now()) {
  const dado = String(codigo || "").replace(/\s/g, "");
  if (!secreto || !/^\d{6}$/.test(dado)) return { ok: false };
  const actual = ventanaDe(ahora);
  for (const v of [actual, actual - 1, actual + 1]) {
    const esperado = Buffer.from(codigoDe(firmaHex(secreto, socioId, v))), recibido = Buffer.from(dado);
    if (crypto.timingSafeEqual(esperado, recibido)) return { ok: true, ventana: v };
  }
  return { ok: false };
}

module.exports = { VENTANA_S, ventanaDe, generarToken, parsearToken, verificarToken, verificarCodigo };
