"use strict";
// Subastas (lotes) + pujas. Idempotente.
// Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-subastas.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  await sql`CREATE TABLE IF NOT EXISTS subastas (
    id             TEXT PRIMARY KEY,
    titulo         TEXT NOT NULL,
    descripcion    TEXT DEFAULT '',
    imagen         TEXT,                            -- URL de la foto del lote (opcional)
    emoji          TEXT DEFAULT '🔨',
    nivel_min      TEXT NOT NULL DEFAULT 'premium', -- quién puede pujar (premium = Plus y Socio)
    precio_inicial INTEGER NOT NULL DEFAULT 0,
    incremento     INTEGER NOT NULL DEFAULT 50000,
    puja_actual    INTEGER NOT NULL DEFAULT 0,      -- denormalizado = max(pujas) o precio_inicial
    ganador_id     TEXT REFERENCES socios(id) ON DELETE SET NULL,  -- líder actual / ganador al cerrar
    inicia         TIMESTAMPTZ NOT NULL DEFAULT now(),
    termina        TIMESTAMPTZ NOT NULL,
    estado         TEXT NOT NULL DEFAULT 'activa',  -- activa | cerrada
    notificado     BOOLEAN NOT NULL DEFAULT false,  -- ya se avisó al ganador
    creado         TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_subastas_estado ON subastas(estado, termina)`;
  // Duración en horas — se usa al "poner en vivo" para calcular `termina` = now + duracion_horas.
  await sql`ALTER TABLE subastas ADD COLUMN IF NOT EXISTS duracion_horas INTEGER`;
  // Los borradores todavía no tienen fecha de cierre (se setea al publicar) → termina nullable.
  await sql`ALTER TABLE subastas ALTER COLUMN termina DROP NOT NULL`;

  await sql`CREATE TABLE IF NOT EXISTS pujas (
    id         TEXT PRIMARY KEY,
    subasta_id TEXT NOT NULL REFERENCES subastas(id) ON DELETE CASCADE,
    socio_id   TEXT NOT NULL REFERENCES socios(id) ON DELETE CASCADE,
    monto      INTEGER NOT NULL,
    creado     TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pujas_subasta ON pujas(subasta_id, monto DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pujas_socio ON pujas(socio_id)`;

  console.log("OK: subastas + pujas");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
