-- 0017_push — notificaciones push (Web Push).
--
--   push_suscripciones   un dispositivo/navegador suscripto de una persona (endpoint único). Si el navegador la anula, se borra sola.
--   socios.push_prefs    qué avisos quiere: {"subasta":true,"pago":true,"beneficio":true,"partido":true}. Vacío = todos.
--
-- Aditiva. Los avisos son de 4 tipos: te superaron en una subasta, vence tu plazo de pago, beneficio de tu ciudad, aviso del club.
CREATE TABLE IF NOT EXISTS public.push_suscripciones (
  id        text PRIMARY KEY,
  socio_id  text NOT NULL REFERENCES public.socios(id) ON DELETE CASCADE,
  endpoint  text NOT NULL UNIQUE,
  p256dh    text NOT NULL,
  auth      text NOT NULL,
  ua        text NOT NULL DEFAULT '',
  creado    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_suscripciones_socio ON public.push_suscripciones (socio_id);
ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS push_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
