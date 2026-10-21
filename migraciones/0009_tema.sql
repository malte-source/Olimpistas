-- 0009_tema — preferencia de apariencia del hincha, que lo acompaña entre dispositivos.
--
--   NULL      = nunca eligió: se mantiene el comportamiento de siempre (oscuro, o lo que guardó ese navegador).
--   'auto'    = sigue la configuración del dispositivo (prefers-color-scheme).
--   'claro' | 'oscuro' = elección explícita.
--
-- (El paquete de diseño proponía NOT NULL DEFAULT 'auto'; con eso a todo hincha existente con el sistema en claro
-- se le cambiaría la app sin tocar nada. NULL conserva lo actual hasta que elija.)
-- Aditiva.

ALTER TABLE public.socios ADD COLUMN IF NOT EXISTS tema text;
DO $$ BEGIN
  ALTER TABLE public.socios ADD CONSTRAINT socios_tema_valido CHECK (tema IS NULL OR tema IN ('auto', 'claro', 'oscuro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
