-- Padrón de las peñas: el listado oficial de miembros (informe del club), aparte de las cuentas de Olimpistas.
-- Una persona que todavía no se registró figura acá; cuando carga o valida su cédula se vincula con su cuenta y se suma a su peña.
-- El estado de la cuota (al día / en mora) lo ve solo el admin. Aditiva: el código anterior sigue andando sin esta tabla.
CREATE TABLE IF NOT EXISTS public.pena_miembros (
  id           text PRIMARY KEY,
  pena_id      text NOT NULL REFERENCES public.penas(id) ON DELETE CASCADE,
  cedula       text NOT NULL DEFAULT '',
  nombre       text NOT NULL DEFAULT '',
  nro_socio    text NOT NULL DEFAULT '',
  estado_cuota text NOT NULL DEFAULT 'sin_dato',          -- al_dia | en_mora | sin_dato
  orden        integer NOT NULL DEFAULT 0,                -- orden de aparición en el informe: si está en dos peñas, manda la primera
  fuente       text NOT NULL DEFAULT '',
  socio_id     text,                                       -- cuenta de Olimpistas con la misma cédula
  creado       timestamptz NOT NULL DEFAULT now(),
  actualizado  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pena_miembros_pena_cedula ON public.pena_miembros (pena_id, cedula) WHERE cedula <> '';
CREATE UNIQUE INDEX IF NOT EXISTS pena_miembros_pena_nombre ON public.pena_miembros (pena_id, nombre) WHERE cedula = '';
CREATE INDEX IF NOT EXISTS pena_miembros_cedula ON public.pena_miembros (cedula) WHERE cedula <> '';
CREATE INDEX IF NOT EXISTS pena_miembros_socio ON public.pena_miembros (socio_id) WHERE socio_id IS NOT NULL;
