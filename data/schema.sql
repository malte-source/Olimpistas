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
  -- Campos de enriquecimiento (barra de progreso de perfil):
  whatsapp      TEXT DEFAULT '',
  foto          TEXT DEFAULT '',          -- data URL (o, en prod, URL a Cloud Storage)
  pais          TEXT DEFAULT '',          -- nombre legible del país
  pais_iso      TEXT DEFAULT '',          -- ISO-3166 alpha-2 (PY, AR…), para el globo/contador
  ciudad        TEXT DEFAULT '',
  lat           DOUBLE PRECISION,         -- ubicación exacta (opcional)
  lng           DOUBLE PRECISION,
  email_verificado BOOLEAN NOT NULL DEFAULT false,
  verif_token   TEXT,                     -- token de verificación de email
  mostrar_exacto BOOLEAN NOT NULL DEFAULT false, -- gamificación: "bandera en mi casa" (punto exacto público)
  cedula        TEXT DEFAULT '',          -- documento (opcional), para reconocer socios de Olimpia
  es_socio_olimpia BOOLEAN NOT NULL DEFAULT false, -- reconocido contra el padrón oficial → Premium
  creado        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- En una base YA creada, correr esta migración una vez:
--   ALTER TABLE socios ADD COLUMN IF NOT EXISTS email_verificado BOOLEAN NOT NULL DEFAULT false,
--                      ADD COLUMN IF NOT EXISTS verif_token TEXT,
--                      ADD COLUMN IF NOT EXISTS mostrar_exacto BOOLEAN NOT NULL DEFAULT false,
--                      ADD COLUMN IF NOT EXISTS cedula TEXT DEFAULT '',
--                      ADD COLUMN IF NOT EXISTS es_socio_olimpia BOOLEAN NOT NULL DEFAULT false;
-- Acelera el agregado del contador/globo (GROUP BY pais_iso) a escala.
CREATE INDEX IF NOT EXISTS idx_socios_pais ON socios(pais_iso);
-- Acelera la consulta de banderas "en tu casa" por recuadro (bbox) a zoom alto.
CREATE INDEX IF NOT EXISTS idx_socios_exacto ON socios(mostrar_exacto) WHERE mostrar_exacto = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- Padrón oficial de socios de Olimpia (base que aporta el club). Al registrarse,
-- si el email o la cédula coinciden → se reconoce al socio y se sube a Premium.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS padron_olimpia (
  id         TEXT PRIMARY KEY,
  cedula     TEXT DEFAULT '',
  email      TEXT DEFAULT '',
  nombre     TEXT DEFAULT '',
  telefono   TEXT DEFAULT '',
  nro_socio  TEXT DEFAULT '',
  reclamado  BOOLEAN NOT NULL DEFAULT false,  -- ya activó su cuenta en la app
  socio_id   TEXT,                            -- a qué cuenta quedó vinculado
  creado     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_padron_email  ON padron_olimpia(lower(email)) WHERE email <> '';
CREATE INDEX IF NOT EXISTS idx_padron_cedula ON padron_olimpia(cedula) WHERE cedula <> '';

CREATE TABLE IF NOT EXISTS sesiones (
  token     TEXT PRIMARY KEY,
  socio_id  TEXT NOT NULL REFERENCES socios(id) ON DELETE CASCADE,
  expira    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sesiones_socio ON sesiones(socio_id);

CREATE TABLE IF NOT EXISTS membresias (
  id        TEXT PRIMARY KEY,
  socio_id  TEXT NOT NULL REFERENCES socios(id) ON DELETE CASCADE,
  tier_slug TEXT NOT NULL,                          -- olimpista | kids | premium
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
  tier_slug   TEXT,                                 -- tier que se está comprando
  ciclo       TEXT NOT NULL DEFAULT 'anio',
  estado      TEXT NOT NULL DEFAULT 'pendiente',    -- pendiente | pagado | rechazado | cancelado
  ref_externa TEXT,                                 -- hash/identificador de PAGOPAR
  creado      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pedidos_socio ON pedidos_pago(socio_id);
