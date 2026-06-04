-- Sección Follow Ups en el CRM
--
-- Reemplaza los eventos all-day "Follow Up - X" del Google Calendar de Fer
-- por una tabla dedicada en el CRM. Beneficios:
-- 1. El calendar de Fer queda libre → Vambe puede agendar leads en cualquier hueco
-- 2. Follow Ups quedan junto a su lead, con historial
-- 3. Fer puede marcar completados, agregar notas, reprogramar

CREATE TABLE IF NOT EXISTS follow_ups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID NULL REFERENCES leads(id) ON DELETE SET NULL,
  titulo      TEXT NOT NULL,
  notas       TEXT NULL,
  fecha       TIMESTAMPTZ NOT NULL,
  tipo        TEXT NOT NULL DEFAULT 'general',  -- 'llamada' | 'mensaje' | 'pago' | 'presentacion' | 'general'
  completado  BOOLEAN NOT NULL DEFAULT false,
  completado_at TIMESTAMPTZ NULL,
  source      TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'gcal_import' | 'auto_presentacion'
  gcal_event_id TEXT NULL,                       -- referencia al evento original de GCal si vino de import
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_fecha ON follow_ups (fecha);
CREATE INDEX IF NOT EXISTS idx_follow_ups_lead ON follow_ups (lead_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_pending ON follow_ups (fecha) WHERE completado = false;
CREATE INDEX IF NOT EXISTS idx_follow_ups_gcal ON follow_ups (gcal_event_id) WHERE gcal_event_id IS NOT NULL;

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION touch_follow_ups_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_follow_ups_updated_at ON follow_ups;
CREATE TRIGGER trg_follow_ups_updated_at
  BEFORE UPDATE ON follow_ups
  FOR EACH ROW
  EXECUTE FUNCTION touch_follow_ups_updated_at();
