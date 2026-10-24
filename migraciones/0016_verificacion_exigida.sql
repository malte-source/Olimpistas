-- 0016_verificacion_exigida — cuentas nuevas con el correo pendiente de validar.
--
--   socios.verif_exigida  true en las cuentas que se registran desde ahora (si el correo está habilitado): hasta confirmar el correo
--                         no pueden pujar, pagar, comprar una membresía ni validar su cédula de socio. Las cuentas que ya existían
--                         quedan en false: ven el aviso para confirmar, pero no se les bloquea nada.
--
-- Aditiva. No marca como verificado a nadie: email_verificado sigue diciendo la verdad.
ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS verif_exigida boolean NOT NULL DEFAULT false;
