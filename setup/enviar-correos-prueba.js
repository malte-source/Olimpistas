"use strict";
// Envía UNA copia de cada correo (con las categorías nuevas) a un email de prueba.
// Uso: RESEND_API_KEY=... node setup/enviar-correos-prueba.js [destino@correo.com]
const mailer = require("../lib/email");

const to = process.argv[2] || "malte@thecrewagencia.com";
const lang = process.argv[3] === "en" ? "en" : "es"; // idioma: es (default) | en
const socio = { id: "soc_prueba_demo", nombre: "Malte", apellido: "Bremer", email: to, idioma: lang };
const APP = process.env.APP_URL || "https://www.olimpistas.com";
const link = APP + "/verificar?token=DEMO";

const correos = [
  ["Verificación (Olimpista free)", () => mailer.enviarVerificacion(socio, link)],
  ["Socio NUEVO reconocido",        () => mailer.enviarReconocido(socio, "socio")],
  ["Reclasificación Plus → Socio",  () => mailer.enviarSocioReclasificado(socio)],
  ["Activación del padrón (Socio)", () => mailer.enviarActivacion(socio, link)],
  ["Socio en revisión",             () => mailer.enviarEnRevision(socio)],
  ["Bienvenida compra PLUS",        () => mailer.enviarBienvenidaCompra(socio, "premium")],
  ["Bienvenida compra JUNIOR",      () => mailer.enviarBienvenidaCompra(socio, "kids")],
  ["Entrada de preventa confirmada", () => mailer.enviarEntradaConfirmada(socio, { evento: "Olimpia vs Cerro Porteño — Superclásico", fecha: "2026-07-20", sede: "Estadio Manuel Ferreira", cantidad: 2 })],
  ["Remarketing pago PLUS",         () => mailer.enviarRemkPago(socio, { tier: "premium" })],
  ["Referido: se sumó tu invitado", () => mailer.enviarReferidoSumado(socio, { invitado: "Ana G.", total: 3 })],
  ["Sorteo: ¡ganaste!",             () => mailer.enviarSorteoGanador(socio, { titulo: "Camiseta firmada del plantel" })],
  ["Cumpleaños",                    () => mailer.enviarCumple(socio)],
  ["Renovación de membresía",       () => mailer.enviarRenovacion(socio, { tier: "premium", dias: 7 })],
  ["Reset de contraseña",           () => mailer.enviarReset(socio, link)],
];

(async () => {
  if (!mailer.habilitado) {
    console.error("⚠️  Falta RESEND_API_KEY → modo simulado (NO se envía nada). Seteala y reintentá.\n");
  }
  console.log(`Enviando ${correos.length} correos de prueba (idioma: ${lang}) a ${to} ...\n`);
  let ok = 0;
  for (const [nombre, fn] of correos) {
    try {
      const r = await fn();
      if (r && r.ok) ok++;
      console.log(`  ${r && r.ok ? "✓" : "✗"} ${nombre}  (${(r && r.modo) || "?"})`);
    } catch (e) {
      console.log(`  ✗ ${nombre} — ${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 600)); // respiro para el rate-limit de Resend
  }
  console.log(`\nListo: ${ok}/${correos.length} enviados.`);
  process.exit(0);
})();
