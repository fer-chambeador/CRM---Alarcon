-- Phase 4: alerts, status_changed_at, two new statuses
-- Run in Supabase SQL editor. Idempotent.

alter table leads add column if not exists status_changed_at timestamptz not null default now();

update leads l set status_changed_at = coalesce(
  (select max(la.created_at) from lead_actividad la
    where la.lead_id = l.id and la.tipo = 'status_change'),
  l.updated_at, l.created_at
)
where status_changed_at = l.created_at;

alter table leads drop constraint if exists leads_status_check;
alter table leads add constraint leads_status_check check (status in (
  'nuevo','contactado','llamada_agendada','no_show_llamada',
  'presentacion_enviada','espera_aprobacion','convertido','cliente_recurrente'
));

create or replace function bump_status_changed_at()
returns trigger as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at = now();
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_bump_status_changed_at on leads;
create trigger trg_bump_status_changed_at
  before update on leads
  for each row execute function bump_status_changed_at();
