-- Membresía de peña de los dos lados: una sola peña por socio, y se es miembro cuando aceptan el socio Y la peña.
--   origen 'socio': el socio pidió sumarse (link ?pena=, buscador) → la comisión de la peña tiene que aceptar.
--   origen 'pena' : la peña ya lo tiene en su padrón (misma cédula) y lo invita → el socio tiene que confirmar.
-- Si alguien pide una peña que ya lo tiene en su padrón, valen las dos aceptaciones a la vez y entra directo.
-- socios.pena_id sigue siendo la única peña de la persona: solo se escribe cuando la solicitud se acepta.
-- Una sola solicitud pendiente por socio (índice único parcial). Aditiva: las peñas ya asignadas no se tocan.
CREATE TABLE IF NOT EXISTS public.pena_solicitudes (
  id        text PRIMARY KEY,
  socio_id  text NOT NULL REFERENCES public.socios(id) ON DELETE CASCADE,
  pena_id   text NOT NULL REFERENCES public.penas(id) ON DELETE CASCADE,
  origen    text NOT NULL,                              -- socio | pena
  estado    text NOT NULL DEFAULT 'pendiente',          -- pendiente | aceptada | rechazada | cancelada
  creado    timestamptz NOT NULL DEFAULT now(),
  resuelto  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS pena_sol_una_pendiente ON public.pena_solicitudes (socio_id) WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS pena_sol_pena ON public.pena_solicitudes (pena_id, estado);
