-- Phase 14: cuándo es la llamada (no cuándo se agendó)
-- Run in Supabase SQL editor. Idempotent.

alter table leads add column if not exists llamada_at timestamptz;
