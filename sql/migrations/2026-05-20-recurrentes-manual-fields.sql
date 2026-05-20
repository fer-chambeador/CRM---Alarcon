-- Agrega columnas para overrides manuales en clientes_recurrentes_meta.
-- El usuario quiere poder ajustar a mano estatus, tipo, contrato y
-- los meses que lleva renovando — porque el cálculo automático puede
-- estar desviado para clientes con pocos pagos o lógica de negocio
-- que no se ve en el sheet.

ALTER TABLE clientes_recurrentes_meta
  ADD COLUMN IF NOT EXISTS estatus         TEXT NULL,
  ADD COLUMN IF NOT EXISTS tipo_cliente    TEXT NULL,
  ADD COLUMN IF NOT EXISTS tipo_contrato   TEXT NULL,
  ADD COLUMN IF NOT EXISTS meses_renovando INTEGER NULL;

-- Validaciones suaves (sin CHECK strict para permitir valores legacy)
COMMENT ON COLUMN clientes_recurrentes_meta.estatus IS 'Override manual del estatus: activo | renovar | churn';
COMMENT ON COLUMN clientes_recurrentes_meta.tipo_cliente IS 'Override manual del tipo: pequeño | mediano | grande | corporativo';
COMMENT ON COLUMN clientes_recurrentes_meta.tipo_contrato IS 'Override manual del contrato: mensual | semestral | anual';
COMMENT ON COLUMN clientes_recurrentes_meta.meses_renovando IS 'Override manual del conteo de meses renovando';
