"use strict";
// Eventos de email de Resend (entregado/abierto/click/rebote/queja) para métricas + supresión.
// Idempotente. Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-email-eventos.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  await sql`CREATE TABLE IF NOT EXISTS email_eventos (
    id          TEXT PRIMARY KEY,
    tipo        TEXT NOT NULL,             -- sent|delivered|opened|clicked|bounced|complained|delivery_delayed
    email       TEXT DEFAULT '',
    message_id  TEXT DEFAULT '',
    asunto      TEXT DEFAULT '',
    creado      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_email_eventos_tipo ON email_eventos(tipo, creado DESC)`;
  console.log("OK: tabla email_eventos");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
