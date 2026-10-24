-- 0018_socios_club — base de referencia de socios del club (exportación del sistema administrativo) + estado consultado a la API de socios.
--
--   socios_club   una fila por cédula. Datos de REFERENCIA (grupo, número de socio, antigüedad creíble, contacto) y el último estado
--                 que devolvió la API de socios del club (ITI/Tuti: ACTIVE, LIFETIME, DEBT, INACTIVE, UNSUBSCRIBED o NO_ENCONTRADO).
--                 No otorga el nivel Socio: sirve para enriquecer y para validar al instante a quien se inscribe. No se expone por ninguna API pública.
--   socios.grupo_club   plan del club de la persona (PERSONAL, ESTADIO, FAMILIAR…), copia de lectura al validar.
--
-- Aditiva. Se carga con setup/importar-socios-club.js y se completa de a poco con las consultas a la API (cron horario).
CREATE TABLE IF NOT EXISTS public.socios_club (
  cedula           text PRIMARY KEY,                 -- dígitos, sin ceros a la izquierda (una RUC se reduce a lo anterior al guion)
  grupo            text NOT NULL DEFAULT '',
  nro_socio        text NOT NULL DEFAULT '',
  socio_desde      date,                             -- solo si la fecha de ingreso es creíble
  fecha_calidad    text NOT NULL DEFAULT '',         -- creible | carga_masiva | sin_fecha | fecha_cero | futura | anterior_1950
  antig_anios      numeric(5,2),
  meses_pagados    integer,
  activo_erp       boolean NOT NULL DEFAULT true,    -- "Activo" del sistema administrativo: NO significa cuotas al día
  nombre           text NOT NULL DEFAULT '',
  correo           text NOT NULL DEFAULT '',
  telefono         text NOT NULL DEFAULT '',
  nacimiento       date,
  en_base          boolean NOT NULL DEFAULT true,    -- false: fila creada solo por una consulta a la API (cédula de la app que no está en el archivo)
  tuti_estado      text NOT NULL DEFAULT '',
  tuti_plan        text NOT NULL DEFAULT '',
  tuti_numero      text NOT NULL DEFAULT '',
  tuti_al_dia      boolean,
  tuti_deuda       integer,
  tuti_consultado  timestamptz,
  tuti_intentos    integer NOT NULL DEFAULT 0,
  importado        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS socios_club_correo ON public.socios_club (correo) WHERE correo <> '';
CREATE INDEX IF NOT EXISTS socios_club_pendientes ON public.socios_club (tuti_intentos, cedula) WHERE tuti_consultado IS NULL;
ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS grupo_club text NOT NULL DEFAULT '';
