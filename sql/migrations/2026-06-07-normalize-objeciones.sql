-- Normaliza custom_analysis->objeciones de string CSV a array para registros existentes.
-- Causa: Dapta a veces devuelve objeciones como "caro, sin presupuesto" en vez de
-- ["caro", "sin presupuesto"]. El frontend LlamadaDetailClient hace .map() y crasheaba.
-- Bug reportado por Fer 7-jun-2026 con caso Lizbeth Chavez Santillan +525512887615.

UPDATE llamadas
SET custom_analysis = jsonb_set(
    custom_analysis,
    '{objeciones}',
    to_jsonb(
      ARRAY(
        SELECT trim(unnest(string_to_array(
          custom_analysis->>'objeciones',
          ','
        )))
      )
    )
  )
WHERE jsonb_typeof(custom_analysis->'objeciones') = 'string'
  AND length(trim(custom_analysis->>'objeciones')) > 0;
