-- ============================================
-- CHAMBAS CRM - Supabase Schema
-- ============================================

create extension if not exists "uuid-ossp";

-- Tabla principal de leads
create table if not exists leads (
  id uuid primary key default uuid_generate_v4(),

  -- Identidad
  email text not null unique,
  nombre text,
  empresa text,
  telefono text,
  puesto text,                        -- Rol en la empresa

  -- Origen
  canal_adquisicion text,             -- Facebook, Metro CDMX, Recomendación, etc.

  -- Estado en el funnel
  status text not null default 'nuevo'
    check (status in ('nuevo', 'contactado', 'en_negociacion', 'convertido', 'descartado')),

  -- Seguimiento de contacto
  veces_contactado integer not null default 0,
  ultimo_contacto timestamptz,

  -- Suscripción
  plan text,                          -- Plan Starter / Pro / Premium / Enterprise
  cupon text,
  suscripcion_fecha timestamptz,

  -- Notas libres
  notas text,

  -- Tipo de evento Slack que lo originó
  tipo_evento text,                   -- usuario_nuevo | empresa_creada | suscripcion_nueva

  -- Metadata Slack
  slack_ts text,                      -- timestamp del mensaje original
  slack_raw text,                     -- texto completo del mensaje (para auditoría)

  -- Timestamps
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Tabla de actividad / log de contactos
create table if not exists lead_actividad (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid references leads(id) on delete cascade,
  tipo text not null,                 -- contacto | nota | status_change | slack_update
  descripcion text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- Trigger para updated_at automático
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger leads_updated_at
  before update on leads
  for each row execute function update_updated_at();

-- Índices
create index if not exists leads_status_idx on leads(status);
create index if not exists leads_created_at_idx on leads(created_at desc);
create index if not exists leads_email_idx on leads(email);
create index if not exists actividad_lead_id_idx on lead_actividad(lead_id);

-- Habilitar Realtime en las tablas
alter publication supabase_realtime add table leads;
alter publication supabase_realtime add table lead_actividad;

-- Row Level Security (básico - todos los usuarios autenticados pueden leer/escribir)
alter table leads enable row level security;
alter table lead_actividad enable row level security;

create policy "Authenticated users full access on leads"
  on leads for all
  using (auth.role() = 'authenticated');

create policy "Authenticated users full access on actividad"
  on lead_actividad for all
  using (auth.role() = 'authenticated');

-- IMPORTANTE: También crea una policy para el service_role (webhook de Slack)
-- El service_role bypasea RLS automáticamente, no necesita policy adicional.
