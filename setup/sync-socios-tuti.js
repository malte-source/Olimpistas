"use strict";
/**
 * sync-socios-tuti.js — Estado de cuenta de los socios contra la API del club (ITI/Tuti).
 *
 * Revisa a cada cuenta con nivel "Socio" activo y cédula cargada, y la clasifica según
 * lo que dice la API HOY (no la foto del padrón de agosto):
 *   al_dia        ACTIVE / LIFETIME
 *   pago_pendiente DEBT — SIGUE siendo socio (debtor + deuda > 0, a menudo paga a mano
 *                 sin débito automático); no es una baja
 *   baja          INACTIVE / UNSUBSCRIBED  ← los únicos candidatos a perder el nivel Socio
 *   sin_dato      404 — NO es motivo de baja: la API no conoce a los ADHERENTES de un plan
 *                 familiar (probado 2026-10-05); esos siguen validados por el padrón
 *   error         timeout / red / credenciales — se reintenta corriendo de nuevo
 *
 * SOLO LECTURA: no modifica ninguna cuenta. Bajar de nivel a alguien es una decisión de
 * negocio (¿mora = pierde el nivel? ¿con gracia?), no de este script. Imprime el resumen
 * y, con --csv <ruta>, deja el detalle (cédula + estado, sin nombres/emails) para revisar.
 *
 *   OLIMPISTAS_DATABASE_URL=... TUTI_API_KEY=... TUTI_MERCHANT_KEY=... \
 *     node setup/sync-socios-tuti.js [--csv salida.csv] [--limit N] [--concurrencia 3]
 */
const postgres = require("postgres");
const fs = require("fs");
const tuti = require("../lib/tuti");

const arg = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const csv = arg("--csv");
const limit = Number(arg("--limit")) || 0;
// Concurrencia baja a propósito: la API corta con 429 (Retry-After 20s) si se la apura.
const CONC = Math.max(1, Math.min(8, Number(arg("--concurrencia")) || 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!tuti.habilitado()) { console.error("Faltan TUTI_API_KEY / TUTI_MERCHANT_KEY."); process.exit(1); }
  const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });
  const rows = await sql`
    SELECT s.id, s.cedula
    FROM socios s JOIN membresias m ON m.socio_id = s.id AND m.estado = 'activa' AND m.tier_slug = 'socio'
    WHERE coalesce(s.cedula, '') <> '' AND s.email NOT LIKE '%@demo.olimpistas.test'
    ORDER BY s.creado ASC ${limit ? sql`LIMIT ${limit}` : sql``}`;
  await sql.end();
  console.log(`Cuentas con nivel Socio y cédula: ${rows.length} · concurrencia ${CONC}\n`);

  const out = []; let i = 0, hechas = 0;
  async function worker() {
    while (i < rows.length) {
      const r = rows[i++];
      // Límite de velocidad (429): esperar lo que pide el proveedor y reintentar LA MISMA
      // cédula — descartarla la dejaría sin revisar. Tope de intentos para no colgarse.
      let q = await tuti.consultarSocio(r.cedula);
      for (let n = 0; n < 8 && !q.ok && q.motivo === "limite"; n++) {
        await sleep((q.reintentarEnMs || 20000) + 500);
        q = await tuti.consultarSocio(r.cedula);
      }
      let clase, status = "";
      if (!q.ok) clase = "error:" + q.motivo;
      else if (!q.encontrado) clase = "sin_dato";
      else { status = q.socio.status; clase = !q.socio.alDia ? "baja" : status === "DEBT" ? "pago_pendiente" : "al_dia"; }
      out.push({ id: r.id, cedula: r.cedula, clase, status });
      if (++hechas % 200 === 0) console.log(`  ${hechas}/${rows.length}`);
      await sleep(150);
      // Credenciales caídas: no tiene sentido seguir golpeando la API.
      if (clase === "error:credenciales") { i = rows.length; }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  const cuenta = {}; for (const o of out) cuenta[o.clase] = (cuenta[o.clase] || 0) + 1;
  const porEstado = {}; for (const o of out) if (o.status) porEstado[o.status] = (porEstado[o.status] || 0) + 1;
  console.log("\n── RESULTADO ──");
  console.log("Por clase:", cuenta);
  console.log("Por estado del club:", porEstado);
  if (csv) {
    fs.writeFileSync(csv, "socio_id,cedula,clase,status\n" + out.map((o) => [o.id, o.cedula, o.clase, o.status].join(",")).join("\n") + "\n");
    console.log("Detalle:", csv);
  }
  console.log("\n(sólo lectura — no se modificó ninguna cuenta)");
})().catch((e) => { console.error(e.message); process.exit(1); });
