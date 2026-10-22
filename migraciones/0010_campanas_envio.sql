-- 0010_campanas_envio — compositor de campañas del club (correo y WhatsApp), envío por tandas.
--
-- `campanas` pasa a guardar el contenido y el estado (enviando | enviada | cancelada); las filas anteriores
-- (la campaña "Completá tu pago", que solo congelaba un cohort) quedan como 'enviada'.
-- `campana_envios` suma el estado de cada envío: '' (legado) | pendiente | tomado | enviado | fallido | omitido.
-- Aditiva: el código anterior sigue funcionando con este esquema.

ALTER TABLE public.campanas ADD COLUMN IF NOT EXISTS canal text NOT NULL DEFAULT 'email';
ALTER TABLE public.campanas ADD COLUMN IF NOT EXISTS plantilla text NOT NULL DEFAULT '';
ALTER TABLE public.campanas ADD COLUMN IF NOT EXISTS asunto text NOT NULL DEFAULT '';
ALTER TABLE public.campanas ADD COLUMN IF NOT EXISTS titulo text NOT NULL DEFAULT '';
ALTER TABLE public.campanas ADD COLUMN IF NOT EXISTS cuerpo text NOT NULL DEFAULT '';
ALTER TABLE public.campanas ADD COLUMN IF NOT EXISTS cta_texto text NOT NULL DEFAULT '';
ALTER TABLE public.campanas ADD COLUMN IF NOT EXISTS cta_url text NOT NULL DEFAULT '';
ALTER TABLE public.campanas ADD COLUMN IF NOT EXISTS cta_valor boolean NOT NULL DEFAULT false;
ALTER TABLE public.campanas ADD COLUMN IF NOT EXISTS filtros jsonb;
ALTER TABLE public.campanas ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'enviada';
ALTER TABLE public.campanas ADD COLUMN IF NOT EXISTS creada_por text NOT NULL DEFAULT '';
ALTER TABLE public.campanas ADD COLUMN IF NOT EXISTS finalizada timestamp with time zone;

ALTER TABLE public.campana_envios ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT '';
ALTER TABLE public.campana_envios ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE public.campana_envios ADD COLUMN IF NOT EXISTS enviado_en timestamp with time zone;
ALTER TABLE public.campana_envios ADD COLUMN IF NOT EXISTS tomado_en timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_campana_envios_pendientes ON public.campana_envios (campana_id, estado) WHERE estado IN ('pendiente', 'tomado');
CREATE INDEX IF NOT EXISTS idx_campanas_estado ON public.campanas (estado) WHERE estado = 'enviando';
