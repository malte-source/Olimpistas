"use strict";
// Agrega `ganador_id` a sorteos — antes el ganador se sorteaba al azar en el admin y se
// perdía (solo quedaba un mail + una línea de auditoría), nunca se guardaba en el sorteo
// ni se mostraba en el historial público de Descubrir. Idempotente.
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-sorteos-ganador.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  await sql`ALTER TABLE sorteos ADD COLUMN IF NOT EXISTS ganador_id TEXT REFERENCES socios(id) ON DELETE SET NULL`;
  console.log("OK: columna ganador_id en sorteos.");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
