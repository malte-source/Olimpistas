"use strict";
// Idioma del socio (para correos bilingües). 'es' por defecto; el front lo manda en el registro.
// Idempotente. Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-idioma.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  await sql`ALTER TABLE socios ADD COLUMN IF NOT EXISTS idioma TEXT NOT NULL DEFAULT 'es'`;
  console.log("OK: socios.idioma");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
