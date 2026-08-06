-- Meta CAPI — evento "Schedule" cuando un lead llega a llamada_agendada.
--
-- 1) meta_capi_schedule_sent_at: idempotencia del envío. NULL = pendiente.
--    El evento se manda UNA sola vez por lead y la marca sobrevive rebotes
--    de status (cancelación → contactado → re-agendada no re-envía).
-- 2) ctwa_clid / fb_ad_id / fb_source_url: atribución de ads Click-to-WhatsApp.
--    Vienen del objeto `referral` que WhatsApp entrega en el primer mensaje
--    del contacto — si Vambe lo reenvía en su webhook (feature request abierto).
-- 3) vambe_pending_leads.meta_attribution: el referral llega ANTES de que el
--    lead exista en el CRM (el lead se materializa al avanzar de stage), así
--    que la atribución se cachea en pending hasta la promoción.

alter table leads add column if not exists meta_capi_schedule_sent_at timestamptz;
alter table leads add column if not exists ctwa_clid text;
alter table leads add column if not exists fb_ad_id text;
alter table leads add column if not exists fb_source_url text;

comment on column leads.meta_capi_schedule_sent_at is
  'Evento Schedule enviado a Meta CAPI. NULL = pendiente. Una sola vez por lead.';
comment on column leads.ctwa_clid is
  'Click ID de ads Click-to-WhatsApp (referral de WhatsApp vía Vambe). Va en user_data.ctwa_clid de Meta CAPI.';

-- La atribución puede llegar en un mensaje SIN formulario → el upsert de
-- meta_attribution no trae form_data. Relajamos el NOT NULL; promotePendingLead
-- ya trata form_data null como "sin form todavía".
alter table vambe_pending_leads alter column form_data drop not null;
alter table vambe_pending_leads add column if not exists meta_attribution jsonb;

-- Sweep del cron /api/cron/meta-capi (cada 10 min). El índice parcial queda
-- vacío en estado estable — solo contiene los agendados aún no enviados.
create index if not exists idx_leads_meta_capi_pending
  on leads (status_changed_at)
  where status = 'llamada_agendada' and meta_capi_schedule_sent_at is null;
