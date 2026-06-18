"use strict";

/**
 * lib/email.js — Emails transaccionales (Resend). Plantillas branded Olimpia.
 *
 * Activación: RESEND_API_KEY + EMAIL_FROM (ej. "Olimpistas <hola@olimpistas.com>").
 * Sin RESEND_API_KEY → modo simulado (solo loguea).
 */

const FROM = process.env.EMAIL_FROM || "Olimpistas <hola@olimpistas.com>";
const APP_URL = process.env.APP_URL || "https://www.olimpistas.com";
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
    if (!r.ok) { console.error("[email] Resend", r.status, await r.text().catch(() => "")); return { ok: false }; }
    return { ok: true, modo: "resend" };
  } catch (e) {
    console.error("[email] error:", e.message);
    return { ok: false };
  }
}

// ── Layout branded reutilizable (negro/oro, sin imágenes externas = llega siempre) ──
function layout({ titulo, intro, ctaText, ctaUrl, nota, badge }) {
  return `
  <div style="background:#07070a;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:480px;margin:0 auto;background:#0f0f15;border:1px solid #23232c;border-radius:18px;overflow:hidden">
      <div style="background:#0b0b0f;padding:24px 20px 20px;text-align:center;border-bottom:2px solid #c9a227">
        <img src="${APP_URL}/assets/logo-email.png" alt="Olimpistas" width="188" style="width:188px;max-width:68%;height:auto;display:inline-block" />
      </div>
      <div style="padding:30px 26px">
        ${badge ? `<div style="text-align:center;margin-bottom:8px"><span style="display:inline-block;background:linear-gradient(120deg,#f0d873,#c9a227);color:#1a1500;font-weight:800;font-size:12px;letter-spacing:1px;padding:5px 14px;border-radius:999px">${badge}</span></div>` : ""}
        <h1 style="margin:0 0 12px;color:#fff;font-size:23px;line-height:1.25;text-align:center">${titulo}</h1>
        <p style="color:#c6c6d0;line-height:1.6;font-size:15px;text-align:center;margin:0 0 24px">${intro}</p>
        ${ctaText ? `<p style="text-align:center;margin:0 0 8px"><a href="${ctaUrl}" style="background:linear-gradient(120deg,#f0d873,#c9a227);color:#1a1500;text-decoration:none;font-weight:800;padding:14px 30px;border-radius:11px;display:inline-block;font-size:15px">${ctaText}</a></p>` : ""}
        ${nota ? `<p style="color:#7d7d86;font-size:12px;text-align:center;margin-top:22px">${nota}</p>` : ""}
      </div>
      <div style="padding:16px;text-align:center;border-top:1px solid #23232c">
        <span style="color:#5f5f68;font-size:11px">Club Olimpia · El Rey de Copas · El Decano</span>
      </div>
    </div>
  </div>`;
}

// ── 1) Verificación + bienvenida (al registrarse) ──
async function enviarVerificacion(socio, link) {
  const n = socio.nombre ? ", " + socio.nombre : "";
  return enviar({
    to: socio.email,
    subject: "¡Ya sos Olimpista! Confirmá tu email 🖤🤍",
    html: layout({
      titulo: `¡Bienvenido al Decano${n}!`,
      intro: "Confirmá tu email para activar tu carnet de Olimpista, aparecer en el mapa mundial y no perderte sorteos, preventas y contenido exclusivo.",
      ctaText: "Confirmar mi email",
      ctaUrl: link,
      nota: "Si no creaste esta cuenta, ignorá este mensaje.",
    }),
  });
}

// ── 2) Reconocido como socio de Olimpia → Premium ──
async function enviarReconocido(socio) {
  const n = socio.nombre ? ", " + socio.nombre : "";
  return enviar({
    to: socio.email,
    subject: "Te reconocimos como socio de Olimpia 🥇",
    html: layout({
      badge: "OLIMPISTA PREMIUM",
      titulo: `¡Sos del Decano de verdad${n}!`,
      intro: "Como socio de Club Olimpia, tu carnet de Olimpista ya es <b style='color:#f0d873'>Premium</b>: contenido exclusivo, preventa prioritaria de entradas y beneficios. Entrá y mirá tu carnet dorado.",
      ctaText: "Ver mi carnet Premium",
      ctaUrl: APP_URL + "/miembro",
    }),
  });
}

// ── 3) Campaña de activación (magic-link, para el padrón) ──
async function enviarActivacion(socio, magicLink) {
  const n = socio.nombre ? ", " + socio.nombre : "";
  return enviar({
    to: socio.email,
    subject: "Activá tu lugar como Olimpista Premium 🥇",
    html: layout({
      badge: "OLIMPISTA PREMIUM",
      titulo: `Tu lugar te espera${n}`,
      intro: "Sos socio de Olimpia, así que ya tenés tu carnet de Olimpista <b style='color:#f0d873'>Premium</b>. Activá tu cuenta en un toque y sumá tu bandera al mapa mundial del Decano.",
      ctaText: "Activar mi cuenta",
      ctaUrl: magicLink,
      nota: "Este enlace es personal. Si no sos socio de Olimpia, ignorá este mensaje.",
    }),
  });
}

module.exports = { enviar, enviarVerificacion, enviarReconocido, enviarActivacion, habilitado, layout };
