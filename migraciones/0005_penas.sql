-- 0005_penas — peñas oficiales: link de captación, panel de la comisión y fondo.
--
--   penas              la peña (pendiente → verificada → pausada) y el saldo de su fondo
--   pena_usuarios      acceso de la comisión al panel. setup_token/setup_exp: link de un solo uso para
--                      elegir la contraseña (no se manda ninguna contraseña por correo)
--   pena_sesiones      sesiones del panel (12 h)
--   pena_movimientos   libro del fondo: ingresos (un pedido acredita UNA sola vez: pedido_id único),
--                      canjes pedidos por la peña (pendiente → aplicado | rechazado) y reversiones
--   socios.pena_id     la peña por la que se sumó el hincha (link ?pena=slug) o que eligió
--   comercios.pena_id  comercio sumado por una peña (se usa en el sprint de comercio)
--
-- Aditiva. Sin datos previos.

CREATE TABLE IF NOT EXISTS public.penas (
  id           text PRIMARY KEY,
  slug         text NOT NULL UNIQUE,
  nombre       text NOT NULL,
  ciudad       text DEFAULT '',
  pais_iso     text DEFAULT 'PY',
  presidente   text DEFAULT '',
  contacto     text DEFAULT '',
  comision_pct numeric(4,2) NOT NULL DEFAULT 10,
  saldo        integer NOT NULL DEFAULT 0,
  estado       text NOT NULL DEFAULT 'pendiente',        -- pendiente | verificada | pausada
  creado       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pena_usuarios (
  id            text PRIMARY KEY,
  pena_id       text NOT NULL REFERENCES public.penas(id) ON DELETE CASCADE,
  usuario       text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  setup_token   text UNIQUE,
  setup_exp     timestamptz,
  creado        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pena_sesiones (
  token   text PRIMARY KEY,
  pena_id text NOT NULL,
  expira  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS public.pena_movimientos (
  id        text PRIMARY KEY,
  pena_id   text NOT NULL REFERENCES public.penas(id) ON DELETE CASCADE,
  pedido_id text UNIQUE,                                  -- un pedido acredita una sola vez
  monto     integer NOT NULL,                             -- + ingreso · − canje
  motivo    text NOT NULL,                                -- ingreso | canje
  detalle   text DEFAULT '',
  estado    text NOT NULL DEFAULT 'aplicado',             -- aplicado | pendiente (canjes) | rechazado | revertido
  creado    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pena_mov_pena ON public.pena_movimientos (pena_id, creado DESC);
CREATE INDEX IF NOT EXISTS idx_pena_mov_pendientes ON public.pena_movimientos (creado) WHERE estado = 'pendiente';

ALTER TABLE public.socios    ADD COLUMN IF NOT EXISTS pena_id text REFERENCES public.penas(id) ON DELETE SET NULL;
ALTER TABLE public.comercios ADD COLUMN IF NOT EXISTS pena_id text REFERENCES public.penas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_socios_pena ON public.socios (pena_id) WHERE pena_id IS NOT NULL;
