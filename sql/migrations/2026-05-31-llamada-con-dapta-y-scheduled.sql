-- Phase 86+87 — Nuevo status 'llamada_con_dapta' + columna scheduled_at en llamadas.
--
-- llamada_con_dapta: bucket donde caen los leads en el momento que se les dispara
-- una llamada Dapta desde el CRM. Si la AI los avanza a otra etapa (llamada_agendada,
-- convertido, etc.), salen del bucket automáticamente porque su status cambia.
--
-- scheduled_at: permite agendar una llamada Dapta para que se dispare en el futuro.
-- Cuando es null o <= now() la llamada se dispara de inmediato (comportamiento actual).

-- 1) Permitir nuevo status en leads
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
  CHECK (status IN (
    'nuevo','contactado','llamada_con_dapta','llamada_agendada','no_show_llamada',
    'presentacion_enviada','espera_aprobacion','convertido','cliente_recurrente','descartado',
    'en_negociacion'   -- legacy, mantener por si quedan filas
  ));

-- 2) Columna scheduled_at en llamadas
ALTER TABLE llamadas ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_llamadas_scheduled_at
  ON llamadas(scheduled_at)
  WHERE scheduled_at IS NOT NULL AND dapta_call_id IS NULL;
