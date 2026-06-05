-- Atomic bump de veces_contactado para evitar race conditions
--
-- ANTES: el código hacía read-modify-write:
--   const lead = await supabase.from('leads').select('*').eq(...).single()
--   await supabase.from('leads').update({ veces_contactado: lead.veces_contactado + 1 })
-- Si dos eventos llegan en paralelo, ambos leen el mismo valor (ej. 2),
-- y ambos hacen update a 3 — se pierde un bump. En el webhook Vambe esto
-- pasaba cuando llegaban 2 message.sent en paralelo (rare pero real).
--
-- AHORA: una función SQL que hace UPDATE atómico con veces_contactado + 1.

CREATE OR REPLACE FUNCTION bump_lead_contacto(
  p_lead_id uuid,
  p_set_contactado boolean DEFAULT false
)
RETURNS TABLE (
  id uuid,
  status text,
  veces_contactado integer,
  ultimo_contacto timestamptz
) AS $$
BEGIN
  IF p_set_contactado THEN
    RETURN QUERY
    UPDATE leads SET
      status = 'contactado',
      status_changed_at = NOW(),
      veces_contactado = COALESCE(veces_contactado, 0) + 1,
      ultimo_contacto = NOW()
    WHERE leads.id = p_lead_id
    RETURNING leads.id, leads.status::text, leads.veces_contactado, leads.ultimo_contacto;
  ELSE
    RETURN QUERY
    UPDATE leads SET
      veces_contactado = COALESCE(veces_contactado, 0) + 1,
      ultimo_contacto = NOW()
    WHERE leads.id = p_lead_id
    RETURNING leads.id, leads.status::text, leads.veces_contactado, leads.ultimo_contacto;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Grant para service-role
GRANT EXECUTE ON FUNCTION bump_lead_contacto(uuid, boolean) TO service_role;
