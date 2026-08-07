"use strict";
// Columnas para recuperar contraseña. Idempotente.
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-reset-password.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });
(async () => {
  await sql`ALTER TABLE socios ADD COLUMN IF NOT EXISTS reset_token TEXT`;
  await sql`ALTER TABLE socios ADD COLUMN IF NOT EXISTS reset_token_exp TIMESTAMPTZ`;
  await sql`CREATE INDEX IF NOT EXISTS idx_socios_reset_token ON socios(reset_token) WHERE reset_token IS NOT NULL`;
  console.log("OK: columnas reset_token + reset_token_exp listas");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
