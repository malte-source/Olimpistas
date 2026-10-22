-- 0004_ficha360 — Ficha 360 del hincha, segmentos guardados y billetera de ahorro.
--
--   socios.gasto_total       lo que pagó en Olimpistas (suma de pedidos pagados y entregados), en guaraníes
--   socios.ultima_actividad  última vez que usó la cuenta (se actualiza como máximo 1 vez por hora)
--   socios.plan_club         copia de lectura del plan del Portal de Socios (ITTI) al validar; Olimpistas no lo escribe allá
--   segmentos_guardados      filtros de "buscar parecidos" guardados para campañas
--
-- Aditiva. gasto_total se calcula una vez con lo que ya está pagado; desde ahora lo mantiene
-- la entrega del pedido (una sola vez por pedido) y la reversión lo descuenta.

ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS gasto_total      integer NOT NULL DEFAULT 0;
ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS ultima_actividad timestamptz;
ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS plan_club        text DEFAULT '';

UPDATE public.socios s SET gasto_total = x.total
  FROM (SELECT socio_id, SUM(monto)::int AS total FROM public.pedidos_pago
         WHERE estado = 'pagado' AND socio_id IS NOT NULL GROUP BY socio_id) x
 WHERE x.socio_id = s.id AND s.gasto_total = 0;

-- Sin dato mejor, la última actividad es el alta.
UPDATE public.socios SET ultima_actividad = creado WHERE ultima_actividad IS NULL;
ALTER TABLE public.socios ALTER COLUMN ultima_actividad SET DEFAULT now();   -- los socios nuevos nacen con actividad

CREATE TABLE IF NOT EXISTS public.segmentos_guardados (
  id         text PRIMARY KEY,
  nombre     text NOT NULL,
  filtros    text NOT NULL,                      -- JSON
  creado_por text DEFAULT 'admin',
  creado     timestamptz NOT NULL DEFAULT now()
);
