-- 0026 — G8 «pagar a tiempo suma» y G3 «misiones de temporada».
--
--   puntos_reglas.pago_rapido       +50 por pagar un lote en las primeras 24 h de su plazo (una vez por lote: la unicidad de puntos_movimientos lo garantiza)
--   puntos_reglas.mision_temporada  +300 por defecto para las misiones de temporada nuevas; apagarla las deja de premiar a todas
--   misiones_temporada              3 o 4 por torneo, además de la semanal. El progreso NO se guarda: se calcula de lo que ya hay (referidos, canjes,
--                                   rubros, pujas) dentro de [desde, hasta] en hora de Paraguay. Se completan una sola vez por persona: el movimiento
--                                   de puntos (socio, 'mision_temporada', id de la misión) es único.
-- Aditiva.
INSERT INTO public.puntos_reglas (clave, puntos) VALUES ('pago_rapido', 50), ('mision_temporada', 300)
ON CONFLICT (clave) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.misiones_temporada (
  id          text PRIMARY KEY,
  titulo      text NOT NULL,
  descripcion text NOT NULL DEFAULT '',
  metrica     text NOT NULL CHECK (metrica IN ('referidos', 'canjes', 'rubros', 'pujas')),
  meta        integer NOT NULL CHECK (meta > 0),
  desde       date NOT NULL,
  hasta       date NOT NULL,
  puntos      integer NOT NULL CHECK (puntos > 0),
  activa      boolean NOT NULL DEFAULT true,
  creado      timestamptz NOT NULL DEFAULT now(),
  CHECK (hasta >= desde)
);
CREATE INDEX IF NOT EXISTS idx_misiones_temporada_vigencia ON public.misiones_temporada (desde, hasta) WHERE activa;
