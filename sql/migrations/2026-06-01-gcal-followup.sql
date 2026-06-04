-- Follow-up de presentación en Google Calendar
--
-- Cuando un lead pasa a status='presentacion_enviada' (manual o por Dapta con
-- outcome='pidio_presentacion'), creamos un all-day event en GCal 3 días
-- después con título "Follow Up - {nombre} - {telefono}". Aparece como barra
-- arriba del día (estilo recordatorio).
--
-- Usamos un campo SEPARADO de google_calendar_event_id (que es para la llamada
-- agendada) porque un lead puede tener AMBOS al mismo tiempo: una llamada
-- agendada Y un follow-up de presentación.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS gcal_followup_event_id TEXT NULL;

COMMENT ON COLUMN leads.gcal_followup_event_id IS 'ID del all-day event en Google Calendar para el follow-up +3 días post-presentación';
