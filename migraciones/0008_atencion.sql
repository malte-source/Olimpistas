-- 0008_atencion — asistente de atención con IA y bandeja del club.
--
--   atencion_conversaciones  una conversación por hincha y canal (app | whatsapp). estado: ia → humano → resuelta.
--                            derivada_en / humano_responde_en / resuelta_en miden cuánto resuelve la IA y qué tan rápido
--                            responde una persona (indicadores de la bandeja).
--   atencion_mensajes        de: hincha | ia | humano | sistema | tarjeta. `meta` guarda JSON (firma del agente, tarjeta).
--   atencion_config          qué herramientas puede usar el asistente (las enciende o apaga el club).
--   atencion_uso             contador diario de mensajes por hincha (tope de gasto y antiabuso; no guarda texto).
--
-- Aditiva. `liberar_lugar` arranca APAGADA: depende de los endpoints de Tuti para el abono, que todavía no existen.

CREATE TABLE IF NOT EXISTS public.atencion_conversaciones (
  id                 text PRIMARY KEY,
  socio_id           text REFERENCES public.socios(id) ON DELETE SET NULL,
  canal              text NOT NULL DEFAULT 'app',
  estado             text NOT NULL DEFAULT 'ia',
  motivo             text DEFAULT '',
  resumen            text DEFAULT '',
  asignado_a         text,
  derivada_en        timestamptz,
  humano_responde_en timestamptz,
  resuelta_en        timestamptz,
  creado             timestamptz NOT NULL DEFAULT now(),
  actualizado        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT atencion_estado_valido CHECK (estado IN ('ia', 'humano', 'resuelta')),
  CONSTRAINT atencion_canal_valido  CHECK (canal IN ('app', 'whatsapp'))
);
CREATE INDEX IF NOT EXISTS idx_atencion_estado ON public.atencion_conversaciones (estado, actualizado DESC);
CREATE INDEX IF NOT EXISTS idx_atencion_socio  ON public.atencion_conversaciones (socio_id, canal, actualizado DESC);
-- A lo sumo UNA conversación abierta (no resuelta) por hincha y canal, aunque dos mensajes lleguen a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS uq_atencion_abierta ON public.atencion_conversaciones (socio_id, canal)
  WHERE estado <> 'resuelta' AND socio_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.atencion_mensajes (
  id              text PRIMARY KEY,
  conversacion_id text NOT NULL REFERENCES public.atencion_conversaciones(id) ON DELETE CASCADE,
  de              text NOT NULL,
  texto           text NOT NULL,
  meta            text,
  creado          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT atencion_de_valido CHECK (de IN ('hincha', 'ia', 'humano', 'sistema', 'tarjeta'))
);
CREATE INDEX IF NOT EXISTS idx_atencion_mensajes ON public.atencion_mensajes (conversacion_id, creado);

CREATE TABLE IF NOT EXISTS public.atencion_config (
  clave  text PRIMARY KEY,
  activo boolean NOT NULL DEFAULT true
);
INSERT INTO public.atencion_config (clave, activo) VALUES
  ('consultar_cuenta', true), ('listar_beneficios', true), ('liberar_lugar', false),
  ('abrir_pago_subasta', true), ('derivar_a_humano', true)
ON CONFLICT (clave) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.atencion_uso (
  socio_id text NOT NULL REFERENCES public.socios(id) ON DELETE CASCADE,
  dia      date NOT NULL,
  mensajes integer NOT NULL DEFAULT 0,
  PRIMARY KEY (socio_id, dia)
);
