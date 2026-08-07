"use strict";
// El ganador de una subasta paga ONLINE (Pagopar) para confirmar el lote; la entrega
// se coordina por privado (WhatsApp) recién después de acreditado el pago. Agrega:
//  - pedidos_pago.subasta_id: liga el pedido de pago a la subasta (igual patrón que
//    tier_slug para membresías y reserva_id para preventas).
//  - subastas.pago_estado: flag denormalizado para mostrar "pagado" en el detalle
//    sin tener que joinear pedidos_pago cada vez.
// Idempotente. Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-subastas-pago.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  await sql`ALTER TABLE pedidos_pago ADD COLUMN IF NOT EXISTS subasta_id TEXT REFERENCES subastas(id) ON DELETE SET NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pedidos_subasta ON pedidos_pago(subasta_id)`;
  await sql`ALTER TABLE subastas ADD COLUMN IF NOT EXISTS pago_estado TEXT`;
  console.log("OK: pedidos_pago.subasta_id + subastas.pago_estado.");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
