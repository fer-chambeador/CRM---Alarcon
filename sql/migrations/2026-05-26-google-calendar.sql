-- Google Calendar integration: guarda los tokens OAuth y vincula leads con eventos.

CREATE TABLE IF NOT EXISTS google_calendar_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Por ahora 'fer' único (no hay multi-user real). Cuando lo haya,
  -- esto sería el id del usuario.
  user_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  -- 'primary' por default, pero el user puede elegir otro calendar
  calendar_id TEXT DEFAULT 'primary',
  -- Info del Google account conectado (para mostrar en UI)
  google_email TEXT NULL,
  scope TEXT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_google_tokens_user ON google_calendar_tokens(user_id);

-- Vincular cada lead con su evento de Calendar (si tiene)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_calendar_event_id TEXT NULL;

COMMENT ON TABLE google_calendar_tokens IS 'Tokens OAuth de Google Calendar por usuario';
COMMENT ON COLUMN leads.google_calendar_event_id IS 'ID del evento en Google Calendar (si tiene llamada agendada sincronizada)';
