-- 0020_socio_desde_fuente — quién fijó el "Socio desde" de una cuenta.
--
--   socios.socio_desde_fuente   '' (lo puso el sistema desde la base del club) | declarada (la persona dijo su año) | admin (lo fijó un administrador).
--                               Una fecha declarada o fijada por admin NUNCA la pisa la base del club ni una revalidación.
--
-- La base del club tiene fechas de ingreso poco confiables en algunos grupos (VITALICIO, ingreso con la fecha de nacimiento o antes de nacer):
-- esas filas quedan con socios_club.fecha_fuente = 'dudosa' y sin "Socio desde"; la persona ve su número de socio y puede contar desde cuándo lo es.
--
-- Aditiva.
ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS socio_desde_fuente text NOT NULL DEFAULT '';
