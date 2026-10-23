-- 0011_ciudades — ciudades normalizadas (GeoNames cities15000, CC-BY 4.0) y coordenadas de peñas y comercios.
--
-- · `ciudades`: una fila por ciudad de 15.000 habitantes o más (id = geonameid). Se carga con setup/importar-ciudades.js.
-- · `socios.ciudad_id`: la ciudad oficial del hincha (la elige con el autocompletado o se deduce de su casa). Nullable: los
--   hinchas sin ciudad no se dibujan como punto del mapa, suman solo al total de su país.
-- · `penas.lat/lng` y `comercios.lat/lng`: ubicación a nivel ciudad/local para "la peña más cercana" y "beneficios cerca tuyo".
-- Aditiva: el código anterior sigue funcionando.

CREATE TABLE IF NOT EXISTS public.ciudades (
    id integer PRIMARY KEY,
    nombre text NOT NULL,
    nombre_norm text NOT NULL,
    pais_iso text NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    poblacion integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ciudades_prefijo ON public.ciudades (pais_iso, nombre_norm text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_ciudades_prefijo_global ON public.ciudades (nombre_norm text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_ciudades_lat ON public.ciudades (pais_iso, lat);

ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS ciudad_id integer;
CREATE INDEX IF NOT EXISTS idx_socios_ciudad_id ON public.socios (ciudad_id) WHERE ciudad_id IS NOT NULL;

ALTER TABLE public.penas ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE public.penas ADD COLUMN IF NOT EXISTS lng double precision;
ALTER TABLE public.comercios ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE public.comercios ADD COLUMN IF NOT EXISTS lng double precision;
