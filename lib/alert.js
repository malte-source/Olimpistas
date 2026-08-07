"use strict";

/**
 * lib/alert.js — Alertas de incidentes (DB caída, errores 500) para enterarnos
 * ANTES que los usuarios. Fire-and-forget: nunca rompe la request y nunca lanza.
 *
 * Canales (opcionales, se activan por env):
 *   ALERT_WEBHOOK_URL  → POST JSON {text, content} (Slack / Discord / GHL / etc.)
 *   ALERT_EMAIL        → email vía Resend (mailer.enviar)
 *
 * Throttle por clave (default 10 min) para no spamear durante una caída sostenida.
 * El email usa Resend, que es independiente de la DB → la alerta llega aunque la DB esté caída.
 */

const mailer = require("./email");

const COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS) || 10 * 60 * 1000;
const _last = {};

function alertar(clave, subject, detail) {
  try {
    const now = Date.now();
    if (_last[clave] && now - _last[clave] < COOLDOWN_MS) return;
    _last[clave] = now;

    const texto = `🚨 Olimpistas — ${subject}\n${detail || ""}`.slice(0, 1500);

    const url = (process.env.ALERT_WEBHOOK_URL || "").trim();
    if (/^https:\/\//i.test(url) && typeof fetch === "function") {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: texto, content: texto }), // text=Slack, content=Discord
      }).catch(() => {});
    }

    const to = (process.env.ALERT_EMAIL || "").trim();
    if (to && mailer && mailer.enviar) {
      const safe = String(detail || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
      mailer.enviar({ to, subject: `🚨 Olimpistas — ${subject}`, html: `<pre style="font:13px/1.5 monospace;white-space:pre-wrap">${safe}</pre>` }).catch(() => {});
    }
  } catch (e) {
    /* una alerta jamás debe romper nada */
  }
}

module.exports = { alertar };
