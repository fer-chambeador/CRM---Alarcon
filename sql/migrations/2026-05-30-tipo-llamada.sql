-- Phase 74 — Separar tipos de llamada (demo vs comercial)
--
-- Vambe tiene dos stages distintas para llamadas:
--   - "Agendados Consultoría 📆" (971fe009-...) → tipo demo
--   - "Llamadas ☎️"             (cd0ab574-...) → tipo comercial
--   - "Confirmados ✅"          (2fc44415-...) → tipo demo (confirmaron asistencia a consultoría)
--
-- Ambas mapean a status='llamada_agendada' en el CRM, pero ahora distinguimos por tipo_llamada.

-- PG no permite ADD COLUMN IF NOT EXISTS combinado con CHECK inline en el mismo statement.
-- Split en 3 partes (todas idempotentes).

ALTER TABLE leads ADD COLUMN IF NOT EXISTS tipo_llamada text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leads_tipo_llamada_check'
  ) THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_tipo_llamada_check
      CHECK (tipo_llamada IS NULL OR tipo_llamada IN ('demo', 'comercial'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_leads_tipo_llamada ON leads(tipo_llamada);

COMMENT ON COLUMN leads.tipo_llamada IS 'Tipo de llamada agendada: demo (consultoría) o comercial (cierre).';
