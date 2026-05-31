-- Hacer to_number / from_number nullable en llamadas.
--
-- Por qué: el payload post-call de Daniela puede llegar sin to_number en el
-- shape que esperábamos (originalmente lo extraíamos de payload.call.to_number
-- pero el handler le faltaba normalizar bien el shape). Aunque ya arreglamos
-- la extracción, defensivamente permitimos null para no romper inserts si
-- algún día Dapta cambia el shape.
--
-- Además, status 'dialing' es más preciso que 'queued' después de disparar.

ALTER TABLE llamadas ALTER COLUMN to_number DROP NOT NULL;
ALTER TABLE llamadas ALTER COLUMN from_number DROP NOT NULL;

-- Agregar 'dialing' al check de status si no existe ya (incluye 'queued' que ya estaba)
-- Esto solo si el check constraint actual no permite 'dialing' — verificar antes de ejecutar.
DO $$
DECLARE
  current_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO current_def
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  WHERE t.relname = 'llamadas' AND c.conname = 'llamadas_status_check';
  RAISE NOTICE 'Current llamadas_status_check: %', current_def;

  IF current_def IS NOT NULL AND current_def NOT LIKE '%dialing%' THEN
    ALTER TABLE llamadas DROP CONSTRAINT llamadas_status_check;
    ALTER TABLE llamadas ADD CONSTRAINT llamadas_status_check
      CHECK (status IN ('queued','dialing','ringing','in_progress','connected','completed','failed','no_answer','voicemail','canceled'));
  END IF;
END $$;
