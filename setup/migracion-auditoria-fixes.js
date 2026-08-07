"use strict";
// Fixes de la auditoría (2026-08): índices de rendimiento + tabla de idempotencia del cron.
// Idempotente. Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-auditoria-fixes.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  // 1) Encuestas: conteo agregado por opción (resultadosEncuesta usa GROUP BY opcion).
  await sql`CREATE INDEX IF NOT EXISTS idx_resp_enc_opcion ON respuestas_encuesta(encuesta_id, opcion)`;

  // 2) Subastas: COUNT(DISTINCT socio_id) por subasta (contarPujadores).
  await sql`CREATE INDEX IF NOT EXISTS idx_pujas_subasta_socio ON pujas(subasta_id, socio_id)`;

  // 3) Cédula normalizada: índice funcional que matchea la query de getSocioByCedula
  //    (regexp_replace(cedula,'[^0-9]','','g')) → evita el seq scan en la validación del día D.
  await sql`CREATE INDEX IF NOT EXISTS idx_socios_cedula_norm ON socios ((regexp_replace(cedula, '[^0-9]', '', 'g'))) WHERE cedula <> ''`;

  // 4) Idempotencia del cron diario: una notificación por clave (cumple/renov + socio + día).
  await sql`CREATE TABLE IF NOT EXISTS notificaciones_log (
    clave  TEXT PRIMARY KEY,
    creado TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  console.log("OK: índices (encuestas, pujas, cédula) + notificaciones_log");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
