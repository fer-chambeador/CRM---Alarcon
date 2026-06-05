-- Agrega columna prioridad a follow_ups con 3 niveles: urgente / normal / baja.
-- "baja" representa "poco potencial".

ALTER TABLE follow_ups
  ADD COLUMN IF NOT EXISTS prioridad text DEFAULT 'normal' NOT NULL;

ALTER TABLE follow_ups DROP CONSTRAINT IF EXISTS chk_follow_ups_prioridad;
ALTER TABLE follow_ups ADD CONSTRAINT chk_follow_ups_prioridad
  CHECK (prioridad IN ('urgente', 'normal', 'baja'));

CREATE INDEX IF NOT EXISTS idx_follow_ups_prioridad_fecha
  ON follow_ups (prioridad, fecha)
  WHERE completado = false;

-- Backfill auto-priorización basada en tipo:
--   pago         → urgente (liga de pago pendiente = MUY urgente)
--   presentacion → urgente si fecha < NOW() + 3d, sino normal
--   llamada      → normal (callbacks, buzones)
--   general      → normal
--   mensaje      → normal
UPDATE follow_ups
SET prioridad = CASE
  WHEN tipo = 'pago' THEN 'urgente'
  WHEN tipo = 'presentacion' AND fecha < NOW() + INTERVAL '3 days' THEN 'urgente'
  WHEN tipo = 'presentacion' THEN 'normal'
  WHEN tipo = 'llamada' THEN 'normal'
  ELSE 'normal'
END
WHERE completado = false;
