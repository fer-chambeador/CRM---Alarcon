-- Phase 76 — Captura debug de todos los eventos del webhook Vambe.
--
-- Sin esto, perdemos eventos cuyo tipo no reconocemos o cuyo contacto no
-- está aún en `leads`. Esta tabla guarda CADA payload entrante.
-- Para diagnosticar: SELECT * FROM vambe_webhook_log ORDER BY received_at DESC LIMIT 10;

CREATE TABLE IF NOT EXISTS vambe_webhook_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    text,
  ai_contact_id text,
  payload       jsonb,
  received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vambe_webhook_log_received ON vambe_webhook_log(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_vambe_webhook_log_type     ON vambe_webhook_log(event_type);
CREATE INDEX IF NOT EXISTS idx_vambe_webhook_log_contact  ON vambe_webhook_log(ai_contact_id);
