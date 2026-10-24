-- 0015_vitales_ux — medición real de velocidad y estabilidad (Core Web Vitals) de usuarios reales.
--
-- Una fila por visita muestreada: pantalla, LCP / INP / CLS / FCP / TTFB, tipo de dispositivo y de conexión.
-- No guarda cédula, correo, IP ni identificador de la persona. El cron diario borra lo de más de 45 días.
-- Aditiva: el código anterior sigue andando sin esta tabla.
CREATE TABLE IF NOT EXISTS public.vitales_ux (
  id          bigserial PRIMARY KEY,
  creado      timestamptz NOT NULL DEFAULT now(),
  pagina      text NOT NULL,
  lcp         real,
  inp         real,
  cls         real,
  fcp         real,
  ttfb        real,
  dispositivo text NOT NULL DEFAULT '',
  conexion    text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS vitales_ux_creado ON public.vitales_ux (creado);
