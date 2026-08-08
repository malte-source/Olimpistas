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
  nombre        TEXT DEFAULT '',          -- nombre de pila
  apellido      TEXT DEFAULT '',          -- apellido (separado, para orden de base)
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
  cedula        TEXT DEFAULT '',          -- documento, para validar socios. ÚNICO (1 cédula = 1 cuenta)
  fecha_nacimiento DATE,                   -- define tier por edad: <18 → Junior, ≥18 → Plus
  es_socio_olimpia BOOLEAN NOT NULL DEFAULT false, -- validado contra el padrón oficial
  idioma        TEXT NOT NULL DEFAULT 'es', -- idioma del socio (es|en) para correos bilingües
  marketing_baja BOOLEAN NOT NULL DEFAULT false, -- opt-out de correos de marketing (List-Unsubscribe)
  marketing_baja_en TIMESTAMPTZ,
  -- Avisos granulares por email (Perfil, F2) — independientes de marketing_baja.
  avisos_subastas  BOOLEAN NOT NULL DEFAULT true,
  avisos_sorteos   BOOLEAN NOT NULL DEFAULT true,
  avisos_contenido BOOLEAN NOT NULL DEFAULT true,
  creado        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Cédula ÚNICA: una misma cédula no puede usarse en dos cuentas (partial: ignora vacíos).
CREATE UNIQUE INDEX IF NOT EXISTS idx_socios_cedula_unica ON socios(cedula) WHERE cedula <> '';
-- En una base YA creada, correr esta migración una vez:
--   ALTER TABLE socios ADD COLUMN IF NOT EXISTS email_verificado BOOLEAN NOT NULL DEFAULT false,
--                      ADD COLUMN IF NOT EXISTS verif_token TEXT,
--                      ADD COLUMN IF NOT EXISTS mostrar_exacto BOOLEAN NOT NULL DEFAULT false,
--                      ADD COLUMN IF NOT EXISTS cedula TEXT DEFAULT '',
--                      ADD COLUMN IF NOT EXISTS es_socio_olimpia BOOLEAN NOT NULL DEFAULT false,
--                      ADD COLUMN IF NOT EXISTS apellido TEXT DEFAULT '',
--                      ADD COLUMN IF NOT EXISTS fecha_nacimiento DATE;
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
  apellido   TEXT DEFAULT '',
  telefono   TEXT DEFAULT '',
  nro_socio  TEXT DEFAULT '',
  reclamado  BOOLEAN NOT NULL DEFAULT false,  -- ya activó su cuenta en la app
  socio_id   TEXT,                            -- a qué cuenta quedó vinculado
  creado     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_padron_email  ON padron_olimpia(lower(email)) WHERE email <> '';
CREATE INDEX IF NOT EXISTS idx_padron_cedula ON padron_olimpia(cedula) WHERE cedula <> '';

-- ─────────────────────────────────────────────────────────────────────────────
-- Base de ACTUALIZACIÓN (staging). TODO dato capturado en el onboarding aterriza
-- acá primero. El club lo revisa y recién después lo UNIFICA con su base maestra.
-- Nunca se toca la base oficial sin pasar por esta cola de verificación.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS actualizaciones (
  id            TEXT PRIMARY KEY,
  socio_id      TEXT REFERENCES socios(id) ON DELETE SET NULL,
  tipo          TEXT NOT NULL,                 -- alta | enriquecimiento | socio_claim
  -- Snapshot de lo capturado (para auditar sin tocar socios):
  nombre        TEXT DEFAULT '',
  apellido      TEXT DEFAULT '',
  email         TEXT DEFAULT '',
  cedula        TEXT DEFAULT '',
  pais          TEXT DEFAULT '',
  ciudad        TEXT DEFAULT '',
  fecha_nacimiento DATE,
  tiene_selfie  BOOLEAN NOT NULL DEFAULT false,
  tier_pretendido TEXT DEFAULT '',             -- kids | premium (por edad)
  match_padron_id TEXT,                        -- fila del padrón con la que matcheó (si aplica)
  estado        TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | validado_auto | a_revisar | unificado | rechazado
  notas         TEXT DEFAULT '',
  verificado_por TEXT,
  verificado_en  TIMESTAMPTZ,
  creado        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_actualizaciones_estado ON actualizaciones(estado, creado DESC);
CREATE INDEX IF NOT EXISTS idx_actualizaciones_socio  ON actualizaciones(socio_id);

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
  imagen      TEXT,
  ganador_id  TEXT REFERENCES socios(id) ON DELETE SET NULL
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
  estado      TEXT NOT NULL DEFAULT 'pendiente_pago', -- pendiente_pago | pagada | cancelada
  creado      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reservas_estado ON reservas(estado);

CREATE TABLE IF NOT EXISTS pedidos_pago (
  id          TEXT PRIMARY KEY,
  socio_id    TEXT REFERENCES socios(id) ON DELETE SET NULL,
  concepto    TEXT NOT NULL,
  monto       INTEGER NOT NULL,
  moneda      TEXT NOT NULL DEFAULT 'PYG',
  tier_slug   TEXT,                                 -- tier que se está comprando (membresía)
  reserva_id  TEXT,                                 -- reserva de preventa que se está pagando (entradas)
  ciclo       TEXT NOT NULL DEFAULT 'anio',
  estado      TEXT NOT NULL DEFAULT 'pendiente',    -- pendiente | pagado | rechazado | cancelado | reversado
  ref_externa TEXT,                                 -- hash/identificador de PAGOPAR
  creado      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pedidos_socio ON pedidos_pago(socio_id);

-- Log de acciones del panel de admin (auditoría: quién hizo qué).
CREATE TABLE IF NOT EXISTS acciones_admin (
  id        TEXT PRIMARY KEY,
  accion    TEXT NOT NULL,        -- editar_socio | activar_tier | baja | reenviar_verif | pedido | actualizacion
  target_id TEXT,                 -- socio_id u otro objetivo
  detalle   TEXT DEFAULT '',
  por       TEXT DEFAULT 'admin',
  creado    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acciones_admin_creado ON acciones_admin(creado DESC);

-- Eventos de email de Resend (métricas de entrega/apertura/click + supresión de rebotes).
CREATE TABLE IF NOT EXISTS email_eventos (
  id          TEXT PRIMARY KEY,
  tipo        TEXT NOT NULL,             -- sent|delivered|opened|clicked|bounced|complained|delivery_delayed
  email       TEXT DEFAULT '',
  message_id  TEXT DEFAULT '',
  asunto      TEXT DEFAULT '',
  creado      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_eventos_tipo ON email_eventos(tipo, creado DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Red de Beneficios: comercios adheridos + beneficios (con niveles) + canjes.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comercios (
  id TEXT PRIMARY KEY, nombre TEXT NOT NULL, rubro TEXT DEFAULT '', logo TEXT DEFAULT '',
  direccion TEXT DEFAULT '', ciudad TEXT DEFAULT '', contacto TEXT DEFAULT '',
  usuario TEXT, password_hash TEXT,
  estado TEXT NOT NULL DEFAULT 'activo', creado TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comercios_usuario ON comercios(usuario) WHERE usuario IS NOT NULL AND usuario <> '';
CREATE TABLE IF NOT EXISTS beneficios (
  id TEXT PRIMARY KEY, comercio_id TEXT NOT NULL REFERENCES comercios(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL, descripcion TEXT DEFAULT '', tipo TEXT DEFAULT 'descuento', valor TEXT DEFAULT '',
  niveles TEXT NOT NULL DEFAULT 'todos', pct NUMERIC, ahorro_estimado INTEGER,
  vigencia_desde DATE, vigencia_hasta DATE, limite_dias INTEGER,
  activo BOOLEAN NOT NULL DEFAULT true, creado TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_beneficios_comercio ON beneficios(comercio_id);
CREATE TABLE IF NOT EXISTS canjes (
  id TEXT PRIMARY KEY, beneficio_id TEXT NOT NULL REFERENCES beneficios(id) ON DELETE CASCADE,
  socio_id TEXT REFERENCES socios(id) ON DELETE SET NULL, comercio_id TEXT, validado_por TEXT DEFAULT '',
  monto INTEGER, ahorro INTEGER, creado TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_canjes_socio ON canjes(socio_id, beneficio_id, creado DESC);
CREATE TABLE IF NOT EXISTS comercio_sesiones (
  token TEXT PRIMARY KEY, comercio_id TEXT NOT NULL, expira TIMESTAMPTZ NOT NULL, creado TIMESTAMPTZ NOT NULL DEFAULT now()
);
