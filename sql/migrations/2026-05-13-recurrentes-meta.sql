-- Phase 19: overrides editables sobre los datos del sheet de recurrentes.
-- Stays separado de la tabla leads — cero impacto en métricas / scoring / alertas.
-- Idempotente.

create table if not exists clientes_recurrentes_meta (
  key text primary key,
  nombre text,
  email text,
  fecha_inicio date,
  canal text,
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists clientes_recurrentes_meta_updated_at on clientes_recurrentes_meta;
create trigger clientes_recurrentes_meta_updated_at
  before update on clientes_recurrentes_meta
  for each row execute function update_updated_at();

alter table clientes_recurrentes_meta enable row level security;

drop policy if exists "Authenticated users full access on clientes_recurrentes_meta"
  on clientes_recurrentes_meta;
create policy "Authenticated users full access on clientes_recurrentes_meta"
  on clientes_recurrentes_meta for all
  using (auth.role() = 'authenticated');
