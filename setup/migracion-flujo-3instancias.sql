-- Migración: flujo de ingreso 3 instancias + base de Actualización.
-- Aditiva e idempotente (IF NOT EXISTS). Aplicar una vez a la base de producción.

-- 1) socios: fecha de nacimiento (tier por edad) + cédula única.
ALTER TABLE socios ADD COLUMN IF NOT EXISTS fecha_nacimiento DATE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_socios_cedula_unica ON socios(cedula) WHERE cedula <> '';

-- 2) Base de ACTUALIZACIÓN (staging de verificación).
CREATE TABLE IF NOT EXISTS actualizaciones (
  id            TEXT PRIMARY KEY,
  socio_id      TEXT REFERENCES socios(id) ON DELETE SET NULL,
  tipo          TEXT NOT NULL,
  nombre        TEXT DEFAULT '',
  apellido      TEXT DEFAULT '',
  email         TEXT DEFAULT '',
  cedula        TEXT DEFAULT '',
  pais          TEXT DEFAULT '',
  ciudad        TEXT DEFAULT '',
  fecha_nacimiento DATE,
  tiene_selfie  BOOLEAN NOT NULL DEFAULT false,
  tier_pretendido TEXT DEFAULT '',
  match_padron_id TEXT,
  estado        TEXT NOT NULL DEFAULT 'pendiente',
  notas         TEXT DEFAULT '',
  verificado_por TEXT,
  verificado_en  TIMESTAMPTZ,
  creado        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_actualizaciones_estado ON actualizaciones(estado, creado DESC);
CREATE INDEX IF NOT EXISTS idx_actualizaciones_socio  ON actualizaciones(socio_id);
