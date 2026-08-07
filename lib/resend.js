"use strict";

/**
 * lib/resend.js — Verificación de la firma de los webhooks de Resend (formato Svix).
 * Headers: svix-id, svix-timestamp, svix-signature. Secreto: "whsec_<base64>".
 * Firma = base64(HMAC-SHA256(secretBytes, `${id}.${timestamp}.${rawBody}`)).
 */
const crypto = require("crypto");

function verificarSvix(secret, { id, timestamp, signature } = {}, rawBody) {
  if (!secret || !id || !timestamp || !signature || !rawBody) return false;
  // Anti-replay: rechazar timestamps de más de 5 min (en cualquier dirección).
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const signed = `${id}.${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", key).update(signed).digest("base64");
  const exp = Buffer.from(expected);
  // El header puede traer varias firmas separadas por espacio, cada una "v1,<base64>".
  return String(signature).split(" ").some((part) => {
    const sig = part.split(",")[1];
    if (!sig) return false;
    const b = Buffer.from(sig);
    return b.length === exp.length && crypto.timingSafeEqual(b, exp);
  });
}

module.exports = { verificarSvix };
