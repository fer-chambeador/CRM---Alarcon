-- Follow Ups: hardening de constraints + UNIQUE en gcal_event_id
--
-- Razones (audit 4 jun 2026):
-- 1. Sin UNIQUE en gcal_event_id, dos workers procesando el cron del import
--    desde GCal pueden insertar dos rows con el mismo evento (race condition).
-- 2. Sin CHECK en `tipo` y `source`, un cliente buggy puede insertar valores
--    fuera del enum esperado.
-- 3. CHECK que `completado_at IS NOT NULL` cuando `completado = true` previene
--    estado inconsistente.

-- UNIQUE: solo cuando gcal_event_id no es NULL (manuales no aplican)
CREATE UNIQUE INDEX IF NOT EXISTS uq_follow_ups_gcal
  ON follow_ups (gcal_event_id)
  WHERE gcal_event_id IS NOT NULL;

-- CHECK: tipo dentro del enum esperado
ALTER TABLE follow_ups DROP CONSTRAINT IF EXISTS chk_follow_ups_tipo;
ALTER TABLE follow_ups ADD CONSTRAINT chk_follow_ups_tipo
  CHECK (tipo IN ('llamada', 'mensaje', 'pago', 'presentacion', 'general'));

-- CHECK: source dentro del enum esperado
ALTER TABLE follow_ups DROP CONSTRAINT IF EXISTS chk_follow_ups_source;
ALTER TABLE follow_ups ADD CONSTRAINT chk_follow_ups_source
  CHECK (source IN ('manual', 'gcal_import', 'auto_presentacion'));

-- CHECK: consistencia entre completado y completado_at
ALTER TABLE follow_ups DROP CONSTRAINT IF EXISTS chk_follow_ups_completado_consistent;
ALTER TABLE follow_ups ADD CONSTRAINT chk_follow_ups_completado_consistent
  CHECK (
    (completado = false AND completado_at IS NULL) OR
    (completado = true  AND completado_at IS NOT NULL)
  );

-- INDEX compuesto: queries comunes "follow ups de este lead ordenados por fecha"
CREATE INDEX IF NOT EXISTS idx_follow_ups_lead_fecha ON follow_ups (lead_id, fecha);
