-- Phase 8: manual override for the lead's state
-- Run in Supabase SQL editor. Idempotent.

alter table leads add column if not exists estado text;

-- nothing to backfill: null = use the auto-detection from LADA.
