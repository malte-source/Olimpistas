-- 0003_subastas_plazo — plazo de pago de subastas, segundo postor y decisiones del club.
--
--   subastas.pago_vence    hasta cuándo puede pagar el adjudicado (NULL = sin plazo)
--   subastas.adjudicado_a  a quién está adjudicado el lote ahora (ronda 1 = ganador, ronda 2 = segundo postor)
--   subastas.ronda         1 ganador · 2 segundo postor
--   socios.subastas_bloqueo_hasta  suspensión para pujar por no haber pagado un lote
--   decisiones_club        decisiones de la Comisión Directiva (plazo, deuda, ...); sin fila = valor por defecto
--
-- Aditiva. Los lotes que ya estaban cerrados se adjudican a su ganador pero SIN plazo
-- (pago_vence queda NULL): así el cron nunca vence ni suspende a nadie por una deuda anterior
-- a esta función. Cada caso viejo se resuelve a mano ("extender plazo" desde el admin).

ALTER TABLE public.subastas ADD COLUMN IF NOT EXISTS pago_vence   timestamptz;
ALTER TABLE public.subastas ADD COLUMN IF NOT EXISTS adjudicado_a text REFERENCES public.socios(id) ON DELETE SET NULL;
ALTER TABLE public.subastas ADD COLUMN IF NOT EXISTS ronda        smallint NOT NULL DEFAULT 1;
ALTER TABLE public.socios   ADD COLUMN IF NOT EXISTS subastas_bloqueo_hasta timestamptz;

UPDATE public.subastas SET adjudicado_a = ganador_id
 WHERE estado = 'cerrada' AND ganador_id IS NOT NULL AND adjudicado_a IS NULL;

CREATE INDEX IF NOT EXISTS idx_subastas_pago_vence ON public.subastas (pago_vence)
 WHERE estado = 'cerrada' AND pago_estado IS DISTINCT FROM 'pagado';

CREATE TABLE IF NOT EXISTS public.decisiones_club (
  clave       text PRIMARY KEY,
  valor       text NOT NULL,
  decidido_por text NOT NULL,
  decidido_en timestamptz NOT NULL DEFAULT now()
);
