-- Phase 61a — Vambe gating: el lead solo se promueve al CRM cuando el stage
-- de Vambe avanza a "Interesado". Mientras tanto, cachamos el formulario.
--
-- Flujo:
--   1) message.received con form  → upsert en vambe_pending_leads
--   2) stage.changed a "Interesado" (mappedStatus === 'nuevo')
--                                  → crear lead en leads + DELETE del pending

CREATE TABLE IF NOT EXISTS vambe_pending_leads (
  vambe_contact_id  text PRIMARY KEY,
  form_data         jsonb NOT NULL,
  raw_event         jsonb,
  received_at       timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vambe_pending_leads_received_at
  ON vambe_pending_leads (received_at DESC);

COMMENT ON TABLE vambe_pending_leads IS
  'Cache de formularios recibidos por Vambe. Se promueve a leads cuando la stage avanza a Interesado.';
