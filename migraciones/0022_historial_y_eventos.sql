-- 0022_historial_y_eventos — la memoria del sistema (Ola B del plan maestro).
--
--   club_estado_historial   cada tramo que una cédula pasó en un estado del club (al_dia | mora | baja): desde, hasta, deuda. Lo escribe guardarEstadoTuti
--                           cuando la API del club cambia lo que dice; así se sabe cuándo entró en mora, cuánto duró y cuándo pagó. Una fila abierta (hasta NULL) por cédula.
--   socio_eventos           los hitos de cada socio con fecha: registro, correo_verificado, foto, nivel_socio_activado / nivel_socio_pausado, primer_canje, primer_pago,
--                           primera_puja, referido. Los "únicos" (unico = true) se guardan una sola vez por socio. Permite embudos por cohorte y "tiempo hasta el primer canje".
--
-- Aditiva. Se reconstruye lo que ya se sabe (marca meta.origen = reconstruido); correo verificado y foto no tienen fecha previa, empiezan desde hoy.

CREATE TABLE IF NOT EXISTS public.club_estado_historial (
  id      bigserial PRIMARY KEY,
  cedula  text NOT NULL,
  clase   text NOT NULL,                       -- al_dia | mora | baja
  estado  text NOT NULL DEFAULT '',            -- lo que dijo la API (ACTIVE, DEBT, INACTIVE, …)
  deuda   integer,
  desde   timestamptz NOT NULL DEFAULT now(),
  hasta   timestamptz,
  inicial boolean NOT NULL DEFAULT false       -- true = foto del primer día (lo que ya sabíamos): no cuenta como "entró en mora" en los indicadores
);
CREATE UNIQUE INDEX IF NOT EXISTS club_hist_abierta ON public.club_estado_historial (cedula) WHERE hasta IS NULL;
CREATE INDEX IF NOT EXISTS club_hist_clase_desde ON public.club_estado_historial (clase, desde);
CREATE INDEX IF NOT EXISTS club_hist_cedula ON public.club_estado_historial (cedula, desde);

INSERT INTO public.club_estado_historial (cedula, clase, estado, deuda, desde, inicial)
SELECT cedula,
       CASE WHEN tuti_estado = 'LIFETIME' THEN 'al_dia'
            WHEN tuti_estado = 'ACTIVE' THEN CASE WHEN coalesce(tuti_deuda, 0) > 0 THEN 'mora' ELSE 'al_dia' END
            WHEN tuti_estado = 'DEBT' THEN 'mora'
            WHEN tuti_estado IN ('INACTIVE', 'UNSUBSCRIBED') THEN 'baja'
            WHEN tuti_al_dia IS TRUE THEN 'al_dia' ELSE 'baja' END,
       tuti_estado, tuti_deuda, coalesce(tuti_consultado, now()), true
FROM public.socios_club
WHERE tuti_estado <> ''
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.socio_eventos (
  id       bigserial PRIMARY KEY,
  socio_id text NOT NULL REFERENCES public.socios(id) ON DELETE CASCADE,
  tipo     text NOT NULL,
  ts       timestamptz NOT NULL DEFAULT now(),
  meta     text,
  unico    boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS socio_eventos_unico ON public.socio_eventos (socio_id, tipo) WHERE unico;
CREATE INDEX IF NOT EXISTS socio_eventos_tipo_ts ON public.socio_eventos (tipo, ts);
CREATE INDEX IF NOT EXISTS socio_eventos_socio_ts ON public.socio_eventos (socio_id, ts);

INSERT INTO public.socio_eventos (socio_id, tipo, ts, meta, unico)
SELECT id, 'registro', creado, '{"origen":"reconstruido"}', true FROM public.socios
ON CONFLICT DO NOTHING;

INSERT INTO public.socio_eventos (socio_id, tipo, ts, meta, unico)
SELECT socio_id, 'primer_canje', MIN(creado), '{"origen":"reconstruido"}', true FROM public.canjes WHERE socio_id IS NOT NULL GROUP BY socio_id
ON CONFLICT DO NOTHING;

INSERT INTO public.socio_eventos (socio_id, tipo, ts, meta, unico)
SELECT socio_id, 'primer_pago', MIN(coalesce(pagado_en, creado)), '{"origen":"reconstruido"}', true FROM public.pedidos_pago WHERE estado = 'pagado' AND socio_id IS NOT NULL GROUP BY socio_id
ON CONFLICT DO NOTHING;

INSERT INTO public.socio_eventos (socio_id, tipo, ts, meta, unico)
SELECT socio_id, 'primera_puja', MIN(creado), '{"origen":"reconstruido"}', true FROM public.pujas GROUP BY socio_id
ON CONFLICT DO NOTHING;

INSERT INTO public.socio_eventos (socio_id, tipo, ts, meta, unico)
SELECT socio_id, 'nivel_socio_activado', MIN(inicio), '{"origen":"reconstruido"}', false FROM public.membresias WHERE tier_slug = 'socio' AND pago_ref LIKE 'socio:%' GROUP BY socio_id;
