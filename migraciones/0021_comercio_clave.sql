-- 0021_comercio_clave — recuperar la contraseña del panel del comercio.
--
--   comercios.clave_token   huella (sha256) del token de un solo uso que va en el link del correo; nunca se guarda el token.
--   comercios.clave_exp     hasta cuándo sirve el link (una hora).
--
-- Aditiva. (Las peñas ya tenían este circuito: pena_usuarios.setup_token / setup_exp.)
ALTER TABLE public.comercios ADD COLUMN IF NOT EXISTS clave_token text;
ALTER TABLE public.comercios ADD COLUMN IF NOT EXISTS clave_exp   timestamptz;
CREATE INDEX IF NOT EXISTS comercios_clave_token ON public.comercios (clave_token) WHERE clave_token IS NOT NULL;
