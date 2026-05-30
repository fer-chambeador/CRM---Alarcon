-- Phase 72 — Campaigns history + metrics
--
-- Track all template sends (campaigns) and their per-recipient outcomes.
-- Drives the "Historial" tab in /templates + analytics + auto-status updates.

CREATE TABLE IF NOT EXISTS vambe_campaigns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       text NOT NULL,
  template_name     text,
  template_body     text,
  segment           jsonb,                  -- filtros usados ({status, canal, vacante, ...})
  override_vars     jsonb,                  -- variables que se mandaron (al menos las globales)
  total_targeted    int  NOT NULL DEFAULT 0,
  total_sent        int  NOT NULL DEFAULT 0,
  total_failed      int  NOT NULL DEFAULT 0,
  source            text NOT NULL DEFAULT 'segment',  -- 'segment' | 'excel' | 'manual'
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vambe_campaign_recipients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid NOT NULL REFERENCES vambe_campaigns(id) ON DELETE CASCADE,
  lead_id             uuid REFERENCES leads(id),    -- nullable si vino de Excel sin matchear lead
  phone               text NOT NULL,
  email               text,
  nombre              text,
  vars                jsonb,                         -- vars específicas para este recipient
  sent_at             timestamptz,
  send_error          text,                          -- razon de fallo si fue rechazado por Vambe
  responded_at        timestamptz,                   -- cuando el cliente respondió por primera vez
  scheduled_call_at   timestamptz,                   -- cuando agendó llamada después de la campaña
  paid_at             timestamptz,                   -- cuando pagó después de la campaña
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vambe_campaigns_created     ON vambe_campaigns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vambe_campaign_recipients_campaign ON vambe_campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_vambe_campaign_recipients_lead     ON vambe_campaign_recipients(lead_id);
CREATE INDEX IF NOT EXISTS idx_vambe_campaign_recipients_phone    ON vambe_campaign_recipients(phone);
CREATE INDEX IF NOT EXISTS idx_vambe_campaign_recipients_sent     ON vambe_campaign_recipients(sent_at DESC);

COMMENT ON TABLE vambe_campaigns IS 'Cada envío masivo de template a leads o lista Excel.';
COMMENT ON TABLE vambe_campaign_recipients IS 'Destinatarios de cada campaign + métricas de outcome (respondió/agendó/pagó).';
