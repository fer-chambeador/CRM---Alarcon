-- Vambe integration: link leads to Vambe contacts + log de mensajes.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS vambe_contact_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS vambe_stage_id   TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_vambe_contact ON leads(vambe_contact_id);

COMMENT ON COLUMN leads.vambe_contact_id IS 'UUID del aiContact en Vambe (link bidireccional CRM↔Vambe)';
COMMENT ON COLUMN leads.vambe_stage_id IS 'Último stage_id conocido en el pipeline de Vambe';
