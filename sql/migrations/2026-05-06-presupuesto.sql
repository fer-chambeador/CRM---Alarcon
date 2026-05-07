-- Phase 9: budget tier captured at onboarding
-- Run in Supabase SQL editor. Idempotent.
-- Existing leads stay null = "No registrado".

alter table leads add column if not exists presupuesto text
  check (presupuesto is null or presupuesto in ('none', '100_to_1000', '2000_to_5000', '10000_plus'));
