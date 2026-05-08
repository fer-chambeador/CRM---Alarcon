-- Phase 13: el "Puesto" que el cliente quiere reclutar
-- (distinto de la columna existente "puesto", que es el "Rol en la empresa"
--  del decision maker — Reclutador, Dueño, etc.)
-- Run in Supabase SQL editor. Idempotent.

alter table leads add column if not exists vacante text;
