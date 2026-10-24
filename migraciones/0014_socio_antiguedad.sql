-- 0014_socio_antiguedad — la antigüedad REAL del socio en el club (no la fecha en que se registró en Olimpistas).
--
--   socios.socio_desde        desde cuándo es socio del club (fecha de alta). Vacío = todavía no la tenemos: el carnet no inventa una.
--   socios.nro_socio          número de socio del club (padrón o API de socios)
--   padron_olimpia.socio_desde  fecha de alta del padrón, para copiarla a la cuenta cuando el socio valida su cédula
--
-- Aditiva. Se carga con setup/cargar-antiguedad.js a partir de un listado del club (cédula + fecha de alta).
ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS socio_desde date;
ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS nro_socio   text NOT NULL DEFAULT '';
ALTER TABLE public.padron_olimpia ADD COLUMN IF NOT EXISTS socio_desde date;
