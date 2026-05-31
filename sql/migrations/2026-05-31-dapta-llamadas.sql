-- Phase 84 — Tabla de llamadas (integración Dapta AI Voice Agent).
--
-- Modelo:
--   - Cada fila = una llamada (1 lead puede tener N llamadas).
--   - Status: queued (creada en CRM) → dialing → connected → completed
--     o estados terminales: failed / no_answer / voicemail / canceled.
--   - dapta_call_id: ID externo de Dapta (único). Se popula cuando llega
--     el webhook post-call.
--   - custom_analysis: JSONB con los 11 campos custom extraídos por la AI:
--       outcome (pidio_link_pago | pidio_presentacion | no_interesado | callback | buzon_voz | numero_equivocado | otro)
--       puesto_buscado, zona_ubicacion, presupuesto_paquete,
--       objeciones (array), usa_otra_plataforma, interes_real (alto|medio|bajo),
--       proximo_paso, resumen_detallado, agendar_seguimiento (ISO8601 o null),
--       sentimiento (positivo|neutral|negativo).
--   - transcript: JSONB array de turnos {speaker, text, timestamp}.
--   - accionables: JSONB con flags derivados del outcome — drives Slack alerts y UI.

CREATE TABLE IF NOT EXISTS llamadas (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           uuid REFERENCES leads(id) ON DELETE CASCADE,

  -- Identidad Dapta
  dapta_call_id     text UNIQUE,
  agent_id          text,
  agent_name        text,                -- snapshot human-readable

  -- Estado
  status            text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','dialing','connected','completed','failed','no_answer','voicemail','canceled')),

  -- Datos de la llamada
  to_number         text NOT NULL,
  from_number       text,
  duration_seconds  integer,
  recording_url     text,

  -- AI output
  transcript        jsonb,                 -- [{speaker, text, ts}]
  summary           text,                  -- resumen corto
  custom_analysis   jsonb,                 -- 11 campos arriba
  outcome           text,                  -- copia denormalizada de custom_analysis.outcome para queries rápidas
  sentimiento       text,                  -- positivo|neutral|negativo
  interes_real      text,                  -- alto|medio|bajo

  -- Accionables derivados
  pidio_link_pago       boolean DEFAULT false,
  pidio_presentacion    boolean DEFAULT false,
  agendar_seguimiento   timestamptz,       -- fecha-hora si quedó callback agendado

  -- Audit
  triggered_by      text,                  -- email del operador que disparó
  trigger_reason    text,                  -- 'manual' | 'auto_nuevo_lead' | etc
  error_message     text,                  -- si status='failed'
  started_at        timestamptz,
  ended_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llamadas_lead         ON llamadas(lead_id);
CREATE INDEX IF NOT EXISTS idx_llamadas_status       ON llamadas(status);
CREATE INDEX IF NOT EXISTS idx_llamadas_outcome      ON llamadas(outcome);
CREATE INDEX IF NOT EXISTS idx_llamadas_created      ON llamadas(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llamadas_dapta_call_id ON llamadas(dapta_call_id);
CREATE INDEX IF NOT EXISTS idx_llamadas_to_number     ON llamadas(to_number);

-- Trigger updated_at automático (reutiliza la función existente en schema.sql)
DROP TRIGGER IF EXISTS llamadas_updated_at ON llamadas;
CREATE TRIGGER llamadas_updated_at
  BEFORE UPDATE ON llamadas
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Realtime para que la UI escuche updates en vivo
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'llamadas'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE llamadas';
  END IF;
END $$;
