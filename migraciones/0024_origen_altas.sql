-- 0024_origen_altas — de dónde vino cada alta.
--
--   socios.origen_fuente   referido | pena | el utm_source del enlace | el sitio que la mandó | directo ('' = alta anterior a esta medición)
--   socios.origen_medio    utm_medium del enlace
--   socios.origen_campana  utm_campaign del enlace
--
-- Permite saber qué canales traen gente que después confirma el correo, llega a Socio, usa un beneficio y paga (Dashboard → "De dónde vienen las altas").
-- Aditiva.
ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS origen_fuente  text NOT NULL DEFAULT '';
ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS origen_medio   text NOT NULL DEFAULT '';
ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS origen_campana text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS socios_origen_fuente ON public.socios (origen_fuente) WHERE origen_fuente <> '';
