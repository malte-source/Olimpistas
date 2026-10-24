-- 0019_club_estado_cuenta — qué dijo el club la última vez que se validó la cédula de una cuenta.
--
--   socios.club_estado    '' (sin validar) | al_dia | mora | baja | revision. "revision" es la respuesta neutra: no figura, o la cuenta no coincide
--                         con la persona del club (así probar cédulas ajenas no revela el estado de pago de nadie).
--   socios.club_deuda     guaraníes pendientes cuando está en mora (solo si la cuenta coincide con la persona del club).
--   socios.club_consulta  cuándo se consultó por última vez; la revisión automática de las cuentas en mora arranca desde acá.
--
--   socios_club.fecha_fuente  de dónde sale el "Socio desde" de cada cédula: ingreso | plan_familiar | primer_cuota | sin_dato (se resuelve al validar la cuenta).
--
-- Aditiva. Quien está en mora ve cuánto debe y un acceso al portal de socios; cuando paga y la API vuelve a decir "al día", el nivel Socio se activa solo.
ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS club_estado   text NOT NULL DEFAULT '';
ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS club_deuda    integer;
ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS club_consulta timestamptz;
CREATE INDEX IF NOT EXISTS socios_club_estado_mora ON public.socios (club_consulta) WHERE club_estado = 'mora';
ALTER TABLE public.socios_club ADD COLUMN IF NOT EXISTS fecha_fuente text NOT NULL DEFAULT '';
-- Correo y nombre con los que el club tiene a la persona (los devuelve la API): permiten saber si una cuenta coincide con ella sin volver a consultar.
ALTER TABLE public.socios_club ADD COLUMN IF NOT EXISTS tuti_correo text NOT NULL DEFAULT '';
ALTER TABLE public.socios_club ADD COLUMN IF NOT EXISTS tuti_nombre text NOT NULL DEFAULT '';
