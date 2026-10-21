-- 0007_carnet_comercio — carnet con QR rotativo y comercio autogestionado.
--
--   socios.carnet_secreto  secreto propio de cada hincha para firmar su QR (se crea la primera vez que lo pide)
--   carnet_usos            ventanas de QR ya usadas en un canje: un QR sirve UNA vez (anti-reuso de una foto)
--   beneficios.estado      borrador (espera aprobación) | aprobado | rechazado. Lo existente queda 'aprobado'
--   beneficios.stock       cupo opcional (NULL = sin tope); baja con cada canje
--   beneficios.origen      club | comercio | pena
--   beneficios.motivo_rechazo  por qué el club rechazó una oferta (lo ve el comercio)
--   canjes.tier_slug       nivel del hincha al canjear (para el "mix por nivel" de las estadísticas)
--
-- Aditiva: lo que ya está publicado sigue publicado.

ALTER TABLE public.socios     ADD COLUMN IF NOT EXISTS carnet_secreto text;
ALTER TABLE public.beneficios ADD COLUMN IF NOT EXISTS estado         text NOT NULL DEFAULT 'aprobado';
ALTER TABLE public.beneficios ADD COLUMN IF NOT EXISTS stock          integer CHECK (stock IS NULL OR stock >= 0);
ALTER TABLE public.beneficios ADD COLUMN IF NOT EXISTS origen         text DEFAULT 'club';
ALTER TABLE public.beneficios ADD COLUMN IF NOT EXISTS motivo_rechazo text;
ALTER TABLE public.canjes     ADD COLUMN IF NOT EXISTS tier_slug      text;

CREATE TABLE IF NOT EXISTS public.carnet_usos (
  socio_id    text NOT NULL REFERENCES public.socios(id) ON DELETE CASCADE,
  ventana     bigint NOT NULL,                           -- floor(epoch / 60 s) del QR usado
  comercio_id text,
  creado      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (socio_id, ventana)
);

CREATE INDEX IF NOT EXISTS idx_canjes_comercio ON public.canjes (comercio_id, creado DESC);
CREATE INDEX IF NOT EXISTS idx_beneficios_estado ON public.beneficios (estado) WHERE estado <> 'aprobado';
