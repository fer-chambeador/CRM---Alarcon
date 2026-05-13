-- Phase 20: soft-delete de clientes recurrentes
-- Idempotente.

alter table clientes_recurrentes_meta
  add column if not exists hidden boolean not null default false;

create index if not exists clientes_recurrentes_meta_hidden_idx
  on clientes_recurrentes_meta (hidden);
