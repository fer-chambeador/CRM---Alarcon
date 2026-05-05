-- ============================================
-- CHAMBAS CRM — Phase 2 migration
-- ============================================
-- Run this in the Supabase SQL editor BEFORE merging the PR that updates
-- the frontend. The new code references status values that don't exist
-- in the old check constraint, so the constraint must be loosened first.
--
-- This migration is idempotent: re-running it is safe.
-- ============================================

begin;

-- 1. Drop old check constraint (was: nuevo, contactado, en_negociacion, convertido, descartado)
alter table leads drop constraint if exists leads_status_check;

-- 2. Migrate the single existing 'en_negociacion' row to 'presentacion_enviada'
--    (chosen because it's the closest stage in the new funnel)
update leads set status = 'presentacion_enviada' where status = 'en_negociacion';

-- 3. New, expanded check constraint
alter table leads
  add constraint leads_status_check
  check (status in (
    'nuevo',
    'contactado',
    'llamada_agendada',
    'presentacion_enviada',
    'convertido',
    'cliente_recurrente'
  ));

-- 4. Pipeline amount per lead (defaults to MXN 1,160)
alter table leads add column if not exists monto numeric(12,2) not null default 1160;

-- 5. Backfill nulls just in case (no-op on a fresh schema, defensive otherwise)
update leads set monto = 1160 where monto is null;

-- 6. Normalize canal_adquisicion to canonical values
--    (mirrors lib/canales.ts — keep both in sync)
update leads
  set canal_adquisicion = case
    when lower(canal_adquisicion) = 'ig' then 'Instagram'
    when lower(canal_adquisicion) like '%instagram%' then 'Instagram'
    when lower(canal_adquisicion) like '%tiktok%' or lower(canal_adquisicion) like '%tik tok%' then 'TikTok'
    when lower(canal_adquisicion) like '%inbound%' then 'Inbound'
    when lower(canal_adquisicion) = 'fb' or lower(canal_adquisicion) like '%facebook%' then 'Facebook'
    when lower(canal_adquisicion) like '%google%' then 'Google'
    when lower(canal_adquisicion) like '%recomenda%' or lower(canal_adquisicion) like '%referral%' then 'Recomendación'
    when lower(canal_adquisicion) like '%linkedin%' then 'LinkedIn'
    when lower(canal_adquisicion) = 'wa' or lower(canal_adquisicion) like '%whatsapp%' then 'WhatsApp'
    else canal_adquisicion
  end
where canal_adquisicion is not null;

commit;

-- ── Rollback notes (manual, only if something breaks) ──
-- begin;
--   alter table leads drop constraint leads_status_check;
--   alter table leads
--     add constraint leads_status_check
--     check (status in ('nuevo','contactado','en_negociacion','convertido','descartado'));
--   -- monto column intentionally NOT dropped — losing data is worse
--   --   than keeping an unused column.
-- commit;
