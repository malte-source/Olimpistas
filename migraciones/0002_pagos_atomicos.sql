-- 0002_pagos_atomicos — estado de cumplimiento de los pedidos de pago.
--
-- Antes: el webhook de Pagopar leía `estado`, lo marcaba "pagado" y recién después entregaba
-- (membresía / entrada / lote). Dos webhooks simultáneos entregaban dos veces, y si la
-- entrega fallaba a mitad, el pedido quedaba "pagado" sin entregar y el reintento de Pagopar
-- lo salteaba para siempre.
--
-- Ahora el cobro y la entrega son dos hechos separados y atómicos:
--   pagado_en           cuándo se acreditó el pago
--   cumplido_en         cuándo terminó la entrega (NULL = falta entregar)
--   cumplimiento_desde  "candado" con vencimiento: quién está entregando ahora mismo
-- Aditiva: el código anterior sigue funcionando con estas columnas presentes.

ALTER TABLE public.pedidos_pago ADD COLUMN IF NOT EXISTS pagado_en timestamptz;
ALTER TABLE public.pedidos_pago ADD COLUMN IF NOT EXISTS cumplido_en timestamptz;
ALTER TABLE public.pedidos_pago ADD COLUMN IF NOT EXISTS cumplimiento_desde timestamptz;

-- Lo que ya figura pagado hasta hoy se da por entregado (no hay que re-entregar nada).
UPDATE public.pedidos_pago
   SET pagado_en = COALESCE(pagado_en, creado), cumplido_en = COALESCE(cumplido_en, creado)
 WHERE estado = 'pagado';

-- La conciliación busca solo pedidos abiertos o sin entregar.
CREATE INDEX IF NOT EXISTS pedidos_pago_abiertos_idx
    ON public.pedidos_pago (creado)
 WHERE estado = 'pendiente' OR (estado = 'pagado' AND cumplido_en IS NULL);
