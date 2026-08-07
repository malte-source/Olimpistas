"use strict";
// Preventas de pago: la reserva ahora tiene ESTADO (se confirma al pagar) y el pedido
// puede referenciar una reserva (compra de entradas), además del tier (membresía).
// Idempotente. Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-preventas-pago.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  await sql`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'pendiente_pago'`;
  await sql`ALTER TABLE pedidos_pago ADD COLUMN IF NOT EXISTS reserva_id TEXT`;
  // Reservas previas a esta feature (eran reservas libres, sin pago) → marcarlas 'pagada'
  // para no dejarlas colgadas como pendientes. Idempotente (no toca las ya pagadas).
  const filas = await sql`UPDATE reservas SET estado = 'pagada' WHERE estado = 'pendiente_pago' RETURNING id`;
  await sql`CREATE INDEX IF NOT EXISTS idx_reservas_estado ON reservas(estado)`;
  console.log("OK: reservas.estado + pedidos_pago.reserva_id. Reservas viejas normalizadas:", filas.length);
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
