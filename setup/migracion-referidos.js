"use strict";
// Loop de referidos: agrega ref_codigo (código corto único por socio) + referido_por. Idempotente.
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-referidos.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });
(async () => {
  await sql`ALTER TABLE socios ADD COLUMN IF NOT EXISTS ref_codigo TEXT`;
  await sql`ALTER TABLE socios ADD COLUMN IF NOT EXISTS referido_por TEXT`;
  // Backfill: código determinístico desde el id (md5 → 10 chars). 10 hex = ~1.1e12 valores →
  // colisión despreciable al volumen actual; índice NO-único para que nunca falle el backfill.
  await sql`UPDATE socios SET ref_codigo = substr(md5(id), 1, 10) WHERE ref_codigo IS NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_socios_ref_codigo ON socios(ref_codigo)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_socios_referido_por ON socios(referido_por) WHERE referido_por IS NOT NULL`;
  console.log("OK: columnas ref_codigo + referido_por listas (con backfill)");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
