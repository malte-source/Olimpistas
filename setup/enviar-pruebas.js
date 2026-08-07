"use strict";
/**
 * setup/enviar-pruebas.js — Envía los 3 correos transaccionales de prueba a una
 * casilla para revisarlos visualmente. Uso:
 *   RESEND_API_KEY=... node setup/enviar-pruebas.js [email-destino]
 */
const mailer = require("../lib/email");

const destino = process.argv[2] || "malte@thecrewagencia.com";
const socio = { email: destino, nombre: "Malte" };
const APP = process.env.APP_URL || "https://www.olimpistas.com";

(async () => {
  console.log(`[pruebas] Resend ${mailer.habilitado ? "ACTIVO" : "SIMULADO (sin RESEND_API_KEY)"} → ${destino}\n`);
  const r1 = await mailer.enviarVerificacion(socio, `${APP}/api/auth/verificar?token=PRUEBA123`);
  console.log("1) Verificación/bienvenida →", r1);
  const r2 = await mailer.enviarReconocido(socio);
  console.log("2) Socio reconocido (Plus) →", r2);
  const r3 = await mailer.enviarActivacion(socio, `${APP}/api/auth/magic?token=PRUEBA123`);
  console.log("3) Activación (magic-link) →", r3);
  console.log("\nListo. Revisá la bandeja de", destino);
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });
