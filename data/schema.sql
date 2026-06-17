-- ─────────────────────────────────────────────────────────────────────────────
-- Olimpistas — Schema Postgres (plataforma de socios de Olimpia)
--
-- Aplicar:  psql "$DATABASE_URL" -f src/socios-olimpia/data/schema.sql
--
-- El catálogo de tiers, contenido, sorteos y preventas se gestiona acá
-- (las semillas mínimas están al final). En el store en memoria viene precargado.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS socios (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nombre        TEXT DEFAULT '',
  telefono      TEXT DEFAULT '',
  creado        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sesiones (
  token     TEXT PRIMARY KEY,
  socio_id  TEXT NOT NULL REFERENCES socios(id) ON DELETE CASCADE,
  expira    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sesiones_socio ON sesiones(socio_id);

CREATE TABLE IF NOT EXISTS membresias (
  id        TEXT PRIMARY KEY,
  socio_id  TEXT NOT NULL REFERENCES socios(id) ON DELETE CASCADE,
  tier_slug TEXT NOT NULL,                          -- oro | plata | olimpista | junior
  ciclo     TEXT NOT NULL DEFAULT 'anio',           -- mes | anio
  estado    TEXT NOT NULL DEFAULT 'activa',         -- activa | reemplazada | cancelada
  inicio    TIMESTAMPTZ NOT NULL DEFAULT now(),
  fin       TIMESTAMPTZ,
  pago_ref  TEXT
);
CREATE INDEX IF NOT EXISTS idx_membresias_socio ON membresias(socio_id, estado);

CREATE TABLE IF NOT EXISTS contenido (
  id          TEXT PRIMARY KEY,
  titulo      TEXT NOT NULL,
  tipo        TEXT NOT NULL DEFAULT 'video',
  tier_min    TEXT NOT NULL DEFAULT 'olimpista',    -- nivel mínimo requerido
  duracion    TEXT,
  thumb       TEXT,
  descripcion TEXT,
  publicado   DATE
);

CREATE TABLE IF NOT EXISTS sorteos (
  id          TEXT PRIMARY KEY,
  titulo      TEXT NOT NULL,
  descripcion TEXT,
  tier_min    TEXT NOT NULL DEFAULT 'olimpista',
  cierra      DATE,
  imagen      TEXT
);

CREATE TABLE IF NOT EXISTS participaciones (
  id        TEXT PRIMARY KEY,
  sorteo_id TEXT NOT NULL REFERENCES sorteos(id) ON DELETE CASCADE,
  socio_id  TEXT NOT NULL REFERENCES socios(id) ON DELETE CASCADE,
  creado    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sorteo_id, socio_id)
);

CREATE TABLE IF NOT EXISTS preventas (
  id           TEXT PRIMARY KEY,
  evento       TEXT NOT NULL,
  fecha        DATE,
  sede         TEXT,
  abre         DATE,
  tier_min     TEXT NOT NULL DEFAULT 'olimpista',
  precio_desde INTEGER,
  imagen       TEXT,
  stock        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reservas (
  id          TEXT PRIMARY KEY,
  preventa_id TEXT NOT NULL REFERENCES preventas(id) ON DELETE CASCADE,
  socio_id    TEXT NOT NULL REFERENCES socios(id) ON DELETE CASCADE,
  cantidad    INTEGER NOT NULL DEFAULT 1,
  creado      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pedidos_pago (
  id          TEXT PRIMARY KEY,
  socio_id    TEXT REFERENCES socios(id) ON DELETE SET NULL,
  concepto    TEXT NOT NULL,
  monto       INTEGER NOT NULL,
  moneda      TEXT NOT NULL DEFAULT 'PYG',
  estado      TEXT NOT NULL DEFAULT 'pendiente',    -- pendiente | pagado | rechazado | cancelado
  ref_externa TEXT,                                 -- hash/identificador de PAGOPAR
  creado      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pedidos_socio ON pedidos_pago(socio_id);
