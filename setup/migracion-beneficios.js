"use strict";
// Red de Beneficios: comercios adheridos + beneficios (con niveles aplicables) + canjes.
// Idempotente. Uso: OLIMPISTAS_DATABASE_URL=... node setup/migracion-beneficios.js
const postgres = require("postgres");
const sql = postgres(process.env.OLIMPISTAS_DATABASE_URL, { max: 2, prepare: false, ssl: "require" });

(async () => {
  await sql`CREATE TABLE IF NOT EXISTS comercios (
    id            TEXT PRIMARY KEY,
    nombre        TEXT NOT NULL,
    rubro         TEXT DEFAULT '',
    logo          TEXT DEFAULT '',
    direccion     TEXT DEFAULT '',
    ciudad        TEXT DEFAULT '',
    contacto      TEXT DEFAULT '',
    usuario       TEXT,                 -- login del panel de validación (único si está seteado)
    password_hash TEXT,
    estado        TEXT NOT NULL DEFAULT 'activo',  -- activo | pausado
    creado        TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_comercios_usuario ON comercios(usuario) WHERE usuario IS NOT NULL AND usuario <> ''`;

  await sql`CREATE TABLE IF NOT EXISTS beneficios (
    id            TEXT PRIMARY KEY,
    comercio_id   TEXT NOT NULL REFERENCES comercios(id) ON DELETE CASCADE,
    titulo        TEXT NOT NULL,
    descripcion   TEXT DEFAULT '',
    tipo          TEXT DEFAULT 'descuento',        -- descuento | 2x1 | regalo | precio
    valor         TEXT DEFAULT '',                  -- ej. "15%", "2x1", "Café gratis"
    niveles       TEXT NOT NULL DEFAULT 'todos',    -- "todos" o CSV: "premium,socio"
    pct           NUMERIC,                          -- % de descuento (para calcular el ahorro: monto*pct/100)
    ahorro_estimado INTEGER,                        -- ahorro fijo estimado (regalo/2x1/precio) si no es %
    vigencia_desde DATE,
    vigencia_hasta DATE,
    limite_dias   INTEGER,                          -- 1 canje cada N días por socio (null = sin límite)
    activo        BOOLEAN NOT NULL DEFAULT true,
    creado        TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_beneficios_comercio ON beneficios(comercio_id)`;

  await sql`CREATE TABLE IF NOT EXISTS canjes (
    id            TEXT PRIMARY KEY,
    beneficio_id  TEXT NOT NULL REFERENCES beneficios(id) ON DELETE CASCADE,
    socio_id      TEXT REFERENCES socios(id) ON DELETE SET NULL,
    comercio_id   TEXT,
    validado_por  TEXT DEFAULT '',
    monto         INTEGER,                          -- monto de la compra reportado por el comercio (Gs)
    ahorro        INTEGER,                          -- ahorro del socio en este canje (Gs)
    creado        TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  // Idempotencia por si la tabla ya existía sin estas columnas:
  await sql`ALTER TABLE beneficios ADD COLUMN IF NOT EXISTS pct NUMERIC`;
  await sql`ALTER TABLE beneficios ADD COLUMN IF NOT EXISTS ahorro_estimado INTEGER`;
  await sql`ALTER TABLE canjes ADD COLUMN IF NOT EXISTS monto INTEGER`;
  await sql`ALTER TABLE canjes ADD COLUMN IF NOT EXISTS ahorro INTEGER`;
  await sql`CREATE INDEX IF NOT EXISTS idx_canjes_socio ON canjes(socio_id, beneficio_id, creado DESC)`;

  // Sesiones del panel de comercio (para la fase del panel de validación).
  await sql`CREATE TABLE IF NOT EXISTS comercio_sesiones (
    token       TEXT PRIMARY KEY,
    comercio_id TEXT NOT NULL,
    expira      TIMESTAMPTZ NOT NULL,
    creado      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  console.log("OK: comercios + beneficios + canjes + comercio_sesiones");
  await sql.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
