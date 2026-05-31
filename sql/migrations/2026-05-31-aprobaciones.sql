-- Tabla `aprobaciones` — approval queue para outbound automatizado.
--
-- Cada fila es un "candidato detectado" que requiere tu approval antes de
-- ejecutarse. Tipos soportados:
--   - 'vambe_template'  → mandar plantilla outbound_primer_mensaje_sales por Vambe
--   - 'dapta_call'      → agendar llamada de Daniela (Dapta) a la hora del lead
--
-- Estados:
--   - 'pending'          — el cron detectó este candidato, esperando tu decisión
--   - 'approved'         — aprobaste y se ejecutó OK
--   - 'rejected_manual'  — dijiste "yo lo hago manual" — no se vuelve a sugerir
--   - 'failed'           — aprobaste pero la ejecución falló (revisar error)
--   - 'expired'          — el lead avanzó de estado antes de que aprobaras
--
-- UNIQUE parcial: solo una aprobación pending por (tipo, lead_id), para que
-- el cron no genere duplicados si corre múltiples veces.

CREATE TABLE IF NOT EXISTS aprobaciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL CHECK (tipo IN ('vambe_template','dapta_call')),
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected_manual','failed','expired')),
  -- vambe_template uses these:
  template_id text,
  template_name text,
  -- dapta_call uses these:
  scheduled_at timestamptz,
  -- Common:
  reason text,                          -- explicación de por qué se sugiere (UI tooltip)
  score_snapshot int,                   -- score del lead al momento de detección
  result_metadata jsonb DEFAULT '{}',   -- response de Vambe/Dapta al aprobar
  error_message text,                   -- si status='failed'
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  expires_at timestamptz                -- cuando deja de tener sentido sugerir esto
);

CREATE INDEX IF NOT EXISTS idx_aprobaciones_pending
  ON aprobaciones(tipo, created_at DESC) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_aprobaciones_lead
  ON aprobaciones(lead_id, tipo, status);

-- Unique partial: solo UNA fila pending por (tipo, lead_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_aprobaciones_pending_per_lead
  ON aprobaciones(tipo, lead_id) WHERE status = 'pending';

-- Realtime publication para que la UI se actualice sola
ALTER PUBLICATION supabase_realtime ADD TABLE aprobaciones;
