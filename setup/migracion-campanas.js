"use strict";
// Tablas de campañas + envíos (para medir tasa de conversión). Idempotente.
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-campanas.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });
(async () => {
  await sql`CREATE TABLE IF NOT EXISTS campanas (
    id             TEXT PRIMARY KEY,
    nombre         TEXT NOT NULL,
    tipo           TEXT DEFAULT '',
    total_enviados INTEGER NOT NULL DEFAULT 0,
    creada         TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS campana_envios (
    id              TEXT PRIMARY KEY,
    campana_id      TEXT NOT NULL,
    socio_id        TEXT,
    email           TEXT DEFAULT '',
    tier_pretendido TEXT DEFAULT '',
    estado_inicial  TEXT DEFAULT '',
    enviado_ok      BOOLEAN NOT NULL DEFAULT false,
    convertido      BOOLEAN NOT NULL DEFAULT false,
    convertido_en   TIMESTAMPTZ,
    creado          TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_campana_envios_camp ON campana_envios(campana_id)`;
  console.log("OK: tablas campanas + campana_envios listas");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
