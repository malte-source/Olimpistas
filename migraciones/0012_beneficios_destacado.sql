-- Beneficios destacados: el admin elige cuáles van de banner arriba de la Red de Beneficios.
-- Aditiva: el código anterior sigue andando sin esta columna.
ALTER TABLE public.beneficios ADD COLUMN IF NOT EXISTS destacado boolean NOT NULL DEFAULT false;
