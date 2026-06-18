"use strict";

/**
 * lib/email.js — Envío de emails transaccionales.
 *
 * ⚠️ INTEGRACIÓN: usa Resend si está RESEND_API_KEY; si no, solo loguea el link
 * (modo dev/sin proveedor). Misma idea que lib/pagopar.js: interfaz estable.
 *
 * Para activar el envío real:
 *   - Crear cuenta en https://resend.com, verificar el dominio remitente.
 *   - Setear RESEND_API_KEY y EMAIL_FROM (ej. "Olimpistas <hola@olimpistas.com>").
 */

const FROM = process.env.EMAIL_FROM || "Olimpistas <onboarding@resend.dev>";
const habilitado = !!process.env.RESEND_API_KEY;

async function enviar({ to, subject, html }) {
  if (!habilitado) {
    console.log(`[email] (simulado, sin RESEND_API_KEY) → ${to} | ${subject}`);
    return { ok: true, modo: "simulado" };
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    if (!r.ok) { console.error("[email] Resend respondió", r.status, await r.text().catch(() => "")); return { ok: false }; }
    return { ok: true, modo: "resend" };
  } catch (e) {
    console.error("[email] error enviando:", e.message);
    return { ok: false };
  }
}

function plantillaVerificacion(nombre, link) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0b0b0f;color:#fff;border-radius:16px;overflow:hidden">
      <div style="background:linear-gradient(120deg,#f0d873,#c9a227);padding:20px;text-align:center">
        <strong style="color:#1a1500;font-size:20px;letter-spacing:1px">OLIMPISTAS</strong>
      </div>
      <div style="padding:28px 24px">
        <h2 style="margin:0 0 10px">¡Bienvenido${nombre ? ", " + nombre : ""}!</h2>
        <p style="color:#c9c9d2;line-height:1.5">Confirmá tu email para completar tu perfil de Olimpista y aparecer en el mapa mundial del Decano.</p>
        <p style="text-align:center;margin:26px 0">
          <a href="${link}" style="background:linear-gradient(120deg,#f0d873,#c9a227);color:#1a1500;text-decoration:none;font-weight:700;padding:13px 28px;border-radius:10px;display:inline-block">Confirmar mi email</a>
        </p>
        <p style="color:#8a8a92;font-size:12px">Si no creaste esta cuenta, ignorá este mensaje.</p>
      </div>
    </div>`;
}

async function enviarVerificacion(socio, link) {
  return enviar({
    to: socio.email,
    subject: "Confirmá tu email — Olimpistas",
    html: plantillaVerificacion(socio.nombre, link),
  });
}

module.exports = { enviar, enviarVerificacion, habilitado };
