-- Phase 10: re-add the "descartado" status (now visible in the funnel for
-- explicit drop-offs). Idempotent.

alter table leads drop constraint if exists leads_status_check;
alter table leads add constraint leads_status_check check (status in (
  'nuevo','contactado','llamada_agendada','no_show_llamada',
  'presentacion_enviada','espera_aprobacion','convertido','cliente_recurrente',
  'descartado'
));
