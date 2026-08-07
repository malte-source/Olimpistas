"use strict";
// Crea las tablas admin_usuarios y admin_sesiones (cuentas reales del panel + sesiones). Idempotente.
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-admin-usuarios.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });
(async () => {
  await sql`CREATE TABLE IF NOT EXISTS admin_usuarios (
    id            TEXT PRIMARY KEY,
    usuario       TEXT NOT NULL UNIQUE,
    nombre        TEXT DEFAULT '',
    password_hash TEXT NOT NULL,
    rol           TEXT NOT NULL DEFAULT 'lectura',
    activo        BOOLEAN NOT NULL DEFAULT true,
    creado        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ultimo_acceso TIMESTAMPTZ
  )`;
  await sql`CREATE TABLE IF NOT EXISTS admin_sesiones (
    token    TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    rol      TEXT NOT NULL,
    expira   TIMESTAMPTZ NOT NULL,
    creado   TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_admin_sesiones_expira ON admin_sesiones(expira)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_admin_sesiones_admin ON admin_sesiones(admin_id)`;
  console.log("OK: tablas admin_usuarios + admin_sesiones listas");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
