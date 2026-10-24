-- 0023_canjes_anulados — el registro de los canjes que un comercio o el club anularon.
--
-- Un canje mal cargado (monto equivocado, beneficio que no era) se anula: el canje se borra de `canjes` (así el ahorro del socio, los rankings y los reportes
-- salen bien sin tocar cada consulta) y acá queda el rastro: qué era, quién lo anuló, cuándo y por qué. El cupo del beneficio vuelve.
--
-- Aditiva. Sin FK a propósito: el registro sobrevive aunque se borre el socio, el comercio o el beneficio.
CREATE TABLE IF NOT EXISTS public.canjes_anulados (
  id           bigserial PRIMARY KEY,
  canje_id     text NOT NULL,
  beneficio_id text,
  socio_id     text,
  comercio_id  text,
  monto        integer,
  ahorro       integer,
  tier_slug    text,
  creado_canje timestamptz,
  anulado_en   timestamptz NOT NULL DEFAULT now(),
  motivo       text NOT NULL DEFAULT '',
  por          text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS canjes_anulados_comercio ON public.canjes_anulados (comercio_id, anulado_en);
CREATE INDEX IF NOT EXISTS canjes_anulados_fecha ON public.canjes_anulados (anulado_en);
