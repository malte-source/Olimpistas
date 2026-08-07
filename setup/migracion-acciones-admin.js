"use strict";
// Crea la tabla acciones_admin (log de auditoría del panel). Idempotente.
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-acciones-admin.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });
(async () => {
  await sql`CREATE TABLE IF NOT EXISTS acciones_admin (
    id        TEXT PRIMARY KEY,
    accion    TEXT NOT NULL,
    target_id TEXT,
    detalle   TEXT DEFAULT '',
    por       TEXT DEFAULT 'admin',
    creado    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_acciones_admin_creado ON acciones_admin(creado DESC)`;
  console.log("OK: tabla acciones_admin lista");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
