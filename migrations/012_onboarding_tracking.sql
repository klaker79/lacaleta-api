-- Migration 012: Onboarding tracking en restaurantes
--
-- Añade 5 columnas para trackear progreso del checklist de onboarding
-- (Proveedores -> Ingredientes -> Recetas -> Pedidos).
-- Decisión Iker 2026-06-03: el checklist no reaparece si el cliente borra
-- todo después de completar. Por eso se persiste timestamp por columna.
--
-- Backfill: tenants existentes con datos ya creados se marcan completados
-- usando created_at del primer registro de cada tipo. Esto evita que un
-- cliente productivo (ej: La Nave 5) vea el onboarding al deplegar.

ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS onboarding_proveedores_at TIMESTAMPTZ;
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS onboarding_ingredientes_at TIMESTAMPTZ;
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS onboarding_recetas_at TIMESTAMPTZ;
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS onboarding_pedidos_at TIMESTAMPTZ;
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS onboarding_completado_at TIMESTAMPTZ;

-- Backfill por tenant: marca cada paso con el created_at del primer registro
UPDATE restaurantes r SET
  onboarding_proveedores_at = COALESCE(
    r.onboarding_proveedores_at,
    (SELECT MIN(created_at) FROM proveedores WHERE restaurante_id = r.id AND deleted_at IS NULL)
  ),
  onboarding_ingredientes_at = COALESCE(
    r.onboarding_ingredientes_at,
    (SELECT MIN(created_at) FROM ingredientes WHERE restaurante_id = r.id AND deleted_at IS NULL)
  ),
  onboarding_recetas_at = COALESCE(
    r.onboarding_recetas_at,
    (SELECT MIN(created_at) FROM recetas WHERE restaurante_id = r.id AND deleted_at IS NULL)
  ),
  onboarding_pedidos_at = COALESCE(
    r.onboarding_pedidos_at,
    (SELECT MIN(fecha_creacion) FROM pedidos WHERE restaurante_id = r.id AND deleted_at IS NULL)
  );

-- Marca completados los tenants con los 4 pasos rellenos
UPDATE restaurantes SET
  onboarding_completado_at = COALESCE(onboarding_completado_at, NOW())
WHERE onboarding_proveedores_at IS NOT NULL
  AND onboarding_ingredientes_at IS NOT NULL
  AND onboarding_recetas_at IS NOT NULL
  AND onboarding_pedidos_at IS NOT NULL;

-- Índice para queries de admin panel (detectar fugas tipo Merci)
CREATE INDEX IF NOT EXISTS idx_restaurantes_onboarding_completado
  ON restaurantes (onboarding_completado_at)
  WHERE onboarding_completado_at IS NULL;
