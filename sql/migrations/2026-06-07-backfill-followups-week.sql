-- Backfill follow_ups para llamadas de la semana del 1-7 jun 2026.
-- Crea automaticamente follow-ups para cada outcome de Daniela.
--
-- También extiende el CHECK constraint del source para permitir 'auto_post_call'.
--
-- Idempotente: solo crea follow-ups si NO existe ya uno para ese lead con
-- source IN ('auto_presentacion','auto_post_call').

-- 1. Extender enum permitido en source
ALTER TABLE follow_ups DROP CONSTRAINT IF EXISTS chk_follow_ups_source;
ALTER TABLE follow_ups ADD CONSTRAINT chk_follow_ups_source
  CHECK (source IN ('manual', 'gcal_import', 'auto_presentacion', 'auto_post_call'));

-- 2. Backfill
DO $$
DECLARE
  fu_target_date timestamp with time zone;
  l record;
  created_count int := 0;
BEGIN
  -- Lunes 8 jun 2026 09:00 a.m. hora MX = 15:00 UTC
  fu_target_date := '2026-06-08 15:00:00+00';

  FOR l IN
    SELECT DISTINCT ON (ll.lead_id)
      ll.id          AS llamada_id,
      ll.lead_id,
      ll.outcome,
      ll.status,
      ll.created_at,
      leads.nombre,
      leads.empresa,
      leads.telefono,
      leads.email
    FROM llamadas ll
    LEFT JOIN leads ON leads.id = ll.lead_id
    WHERE ll.lead_id IS NOT NULL
      AND ll.created_at >= '2026-06-01'
      AND ll.created_at <  '2026-06-08'
      AND ll.outcome IN ('pidio_presentacion', 'pidio_link_pago', 'buzon_voz', 'callback')
      AND NOT EXISTS (
        SELECT 1 FROM follow_ups fu
        WHERE fu.lead_id = ll.lead_id
          AND fu.source IN ('auto_presentacion', 'auto_post_call')
          AND fu.completado = false
      )
    ORDER BY ll.lead_id, ll.created_at DESC
  LOOP
    INSERT INTO follow_ups (lead_id, titulo, notas, fecha, tipo, source, completado)
    VALUES (
      l.lead_id,
      CASE l.outcome
        WHEN 'pidio_presentacion' THEN '📋 Confirmar revisión de presentación — ' || COALESCE(l.nombre, l.telefono, 'lead')
        WHEN 'pidio_link_pago'    THEN '💰 Confirmar pago — ' || COALESCE(l.nombre, l.telefono, 'lead')
        WHEN 'buzon_voz'          THEN '📞 Reintentar llamada (fue a buzón) — ' || COALESCE(l.nombre, l.telefono, 'lead')
        WHEN 'callback'           THEN '📅 Callback agendado — ' || COALESCE(l.nombre, l.telefono, 'lead')
        ELSE 'Follow up — ' || COALESCE(l.nombre, l.telefono, 'lead')
      END,
      'Generado automáticamente desde llamada Dapta del ' || to_char(l.created_at AT TIME ZONE 'America/Mexico_City', 'DD-Mon HH24:MI') ||
        E'. Outcome: ' || l.outcome ||
        CASE WHEN l.empresa IS NOT NULL THEN E'. Empresa: ' || l.empresa ELSE '' END,
      fu_target_date,
      CASE l.outcome
        WHEN 'pidio_presentacion' THEN 'presentacion'
        WHEN 'pidio_link_pago'    THEN 'pago'
        WHEN 'buzon_voz'          THEN 'llamada'
        WHEN 'callback'           THEN 'llamada'
        ELSE 'general'
      END,
      'auto_post_call',
      false
    );
    created_count := created_count + 1;
  END LOOP;
  RAISE NOTICE 'Follow-ups creados: %', created_count;
END $$;
