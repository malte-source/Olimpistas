-- 0006_puntos — motor de puntos: reglas, movimientos, catálogo de premios, canjes y misión semanal.
--
--   puntos_reglas       cuántos puntos da cada regla y si está activa (la edita el club)
--   puntos_movimientos  libro de puntos. UNIQUE (socio_id, motivo, ref_id): cada regla suma UNA vez por
--                       hecho (un referido, una semana, un mes), aunque el evento llegue dos veces.
--                       Canjes y vencimientos son movimientos negativos. El saldo es la suma.
--   premios             catálogo por escalón (bronce | plata | oro); stock NULL = ilimitado
--   canjes_premio       pedido de canje: pendiente → entregado | cancelado (cancelar devuelve los puntos y el stock)
--   misiones            la misión semanal (una pregunta con una respuesta correcta)
--   mision_respuestas   UNA respuesta por socio y misión (con tres opciones, permitir reintentos las regala)
--
-- Aditiva. Las reglas arrancan con los valores del paquete de diseño.

CREATE TABLE IF NOT EXISTS public.puntos_reglas (
  clave  text PRIMARY KEY,
  puntos integer NOT NULL,
  activa boolean NOT NULL DEFAULT true
);
INSERT INTO public.puntos_reglas (clave, puntos) VALUES
  ('referido', 300), ('mision', 50), ('estadio', 150), ('liberar', 200), ('cuota', 100), ('debito', 500), ('perfil', 100)
ON CONFLICT (clave) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.puntos_movimientos (
  id        text PRIMARY KEY,
  socio_id  text NOT NULL REFERENCES public.socios(id) ON DELETE CASCADE,
  puntos    integer NOT NULL,
  motivo    text NOT NULL,
  ref_id    text NOT NULL DEFAULT '',
  detalle   text DEFAULT '',
  vence     timestamptz,
  creado    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (socio_id, motivo, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_puntos_socio ON public.puntos_movimientos (socio_id, creado DESC);

CREATE TABLE IF NOT EXISTS public.premios (
  id          text PRIMARY KEY,
  titulo      text NOT NULL,
  descripcion text DEFAULT '',
  imagen      text,
  escalon     text NOT NULL DEFAULT 'bronce',
  costo       integer NOT NULL CHECK (costo > 0),
  stock       integer CHECK (stock IS NULL OR stock >= 0),
  nivel_min   text NOT NULL DEFAULT 'olimpista',
  activo      boolean NOT NULL DEFAULT true,
  creado      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.canjes_premio (
  id        text PRIMARY KEY,
  socio_id  text NOT NULL REFERENCES public.socios(id) ON DELETE CASCADE,
  premio_id text NOT NULL REFERENCES public.premios(id),
  costo     integer NOT NULL,
  estado    text NOT NULL DEFAULT 'pendiente',           -- pendiente | entregado | cancelado
  creado    timestamptz NOT NULL DEFAULT now(),
  resuelto  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_canjes_premio_estado ON public.canjes_premio (estado, creado);

CREATE TABLE IF NOT EXISTS public.misiones (
  id       text PRIMARY KEY,
  semana   text NOT NULL UNIQUE,                         -- 2026-W43 (semana ISO, hora de Paraguay)
  pregunta text NOT NULL,
  opciones text NOT NULL,                                -- JSON: ["1979","1990","2002"]
  correcta integer NOT NULL,                             -- índice de la opción correcta
  activa   boolean NOT NULL DEFAULT true,
  creado   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mision_respuestas (
  mision_id text NOT NULL REFERENCES public.misiones(id) ON DELETE CASCADE,
  socio_id  text NOT NULL REFERENCES public.socios(id) ON DELETE CASCADE,
  opcion    integer NOT NULL,
  correcta  boolean NOT NULL,
  creado    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mision_id, socio_id)
);
