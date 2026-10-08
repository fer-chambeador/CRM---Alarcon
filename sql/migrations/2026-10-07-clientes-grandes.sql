-- Clientes grandes (Fer, 7-oct-2026): cartera de cuentas que pagan > $5,000.
-- La lista base se calcula en vivo desde el Google Sheet 'Revenue' (pestañas
-- mensuales desde enero). Esta tabla guarda lo que el equipo edita encima:
-- owner, próxima acción, notas, clientes agregados a mano y los eliminados
-- (soft delete: eliminado=true para que el sheet no los vuelva a meter).
-- Aplicar a mano en el SQL editor de Supabase.
create table if not exists clientes_grandes (
  id uuid primary key default gen_random_uuid(),
  cliente_key text not null unique,          -- email del sheet en minúsculas, o 'manual:<uuid>'
  empresa text,
  contacto_nombre text,
  contacto_puesto text,
  telefono text,
  email text,
  owner text not null default 'Sin asignar',
  gasto_manual numeric,                      -- solo para clientes agregados a mano
  plan text,
  proxima_accion text,
  proxima_accion_fecha date,
  ultimo_contacto timestamptz,
  notas text,
  origen text not null default 'sheet',      -- 'sheet' | 'manual'
  eliminado boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists clientes_grandes_owner_idx on clientes_grandes (owner);
