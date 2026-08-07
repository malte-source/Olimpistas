"use strict";
// Baja de marketing: flag para que un socio no reciba correos de marketing (List-Unsubscribe).
// Los transaccionales (verificación, reset, confirmación de pago) NO dependen de esto.
// Idempotente. Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-baja-marketing.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  await sql`ALTER TABLE socios ADD COLUMN IF NOT EXISTS marketing_baja BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE socios ADD COLUMN IF NOT EXISTS marketing_baja_en TIMESTAMPTZ`;
  console.log("OK: socios.marketing_baja + marketing_baja_en");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
