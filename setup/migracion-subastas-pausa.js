"use strict";
// Agrega `pausada_en` a subastas: guarda cuándo se pausó una subasta en vivo para,
// al reanudar, correr el reloj exactamente lo que estuvo en pausa. Idempotente.
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-subastas-pausa.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  await sql`ALTER TABLE subastas ADD COLUMN IF NOT EXISTS pausada_en TIMESTAMPTZ`;
  console.log("OK: columna pausada_en.");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
