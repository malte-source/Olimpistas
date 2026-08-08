"use strict";
// Agrega los 3 toggles de aviso por email que pide F2 (subastas / sorteos-preventas /
// contenido), independientes del opt-out global `marketing_baja`. Default true (todos
// prendidos) para no silenciar a nadie sin que lo pida. Idempotente.
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-avisos-perfil.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  await sql`ALTER TABLE socios ADD COLUMN IF NOT EXISTS avisos_subastas BOOLEAN NOT NULL DEFAULT true`;
  await sql`ALTER TABLE socios ADD COLUMN IF NOT EXISTS avisos_sorteos BOOLEAN NOT NULL DEFAULT true`;
  await sql`ALTER TABLE socios ADD COLUMN IF NOT EXISTS avisos_contenido BOOLEAN NOT NULL DEFAULT true`;
  console.log("OK: socios.avisos_subastas / avisos_sorteos / avisos_contenido");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
