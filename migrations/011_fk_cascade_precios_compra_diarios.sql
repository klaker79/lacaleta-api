-- Migration 011: FK CASCADE para precios_compra_diarios.pedido_id
--
-- Contexto (project_precios_compra_huerfanos):
--   precios_compra_diarios.pedido_id es INTEGER plano (sin FK). Cuando se
--   borra físicamente un pedido (OCR erróneo, limpieza manual), las filas
--   de precios quedan huérfanas y envenenan precio_medio_compra del
--   ingrediente afectado.
--
--   Caso real La Nave 5 (2026-04-21): receta PAN POR PERSONA mostraba food
--   cost 143.9% porque una fila huérfana (precio 12.95 €/kg) dominaba el
--   AVG de los últimos 90 días del ingrediente PAN.
--
-- Esta migration:
--   1. Reporta huérfanos existentes (PRE-CHECK).
--   2. Borra huérfanos: filas con pedido_id NOT NULL pero ese pedido no
--      existe físicamente.
--   3. Añade FK con ON DELETE CASCADE → al borrar un pedido en el futuro,
--      sus filas de precios se eliminan automáticamente.
--
-- Sobre soft-delete de pedidos:
--   La FK CASCADE solo se dispara con DELETE físico. Si un pedido se
--   soft-deleta (UPDATE deleted_at), las filas de precios quedan intactas
--   (comportamiento deseado: el pedido sigue existiendo, solo está oculto).
--
-- IDEMPOTENTE: pre-check no muta nada, DELETE solo borra huérfanos reales
-- (si no hay, no toca nada), ALTER usa DROP IF EXISTS para no fallar si la
-- migration se repite.

BEGIN;

-- PRE-CHECK: ¿cuántos huérfanos hay y qué ingredientes afectan?
SELECT
    COUNT(*) AS total_huerfanos,
    COUNT(DISTINCT pcd.ingrediente_id) AS ingredientes_afectados,
    MIN(pcd.fecha) AS huerfano_mas_antiguo,
    MAX(pcd.fecha) AS huerfano_mas_reciente
FROM precios_compra_diarios pcd
LEFT JOIN pedidos p ON p.id = pcd.pedido_id
WHERE pcd.pedido_id IS NOT NULL
  AND p.id IS NULL;

-- Detalle por ingrediente (para auditoría visual antes del DELETE):
SELECT
    i.restaurante_id,
    pcd.ingrediente_id,
    i.nombre AS ingrediente,
    COUNT(*) AS filas_huerfanas,
    SUM(pcd.total_compra)::numeric(12,2) AS importe_huerfano,
    MIN(pcd.fecha) AS desde,
    MAX(pcd.fecha) AS hasta
FROM precios_compra_diarios pcd
LEFT JOIN pedidos p ON p.id = pcd.pedido_id
JOIN ingredientes i ON i.id = pcd.ingrediente_id
WHERE pcd.pedido_id IS NOT NULL
  AND p.id IS NULL
GROUP BY i.restaurante_id, pcd.ingrediente_id, i.nombre
ORDER BY filas_huerfanas DESC, importe_huerfano DESC;

-- LIMPIEZA: borra las filas huérfanas.
-- Filas con pedido_id IS NULL son legítimas (alta manual sin pedido fuente) → NO se tocan.
DELETE FROM precios_compra_diarios
WHERE id IN (
    SELECT pcd.id
    FROM precios_compra_diarios pcd
    LEFT JOIN pedidos p ON p.id = pcd.pedido_id
    WHERE pcd.pedido_id IS NOT NULL
      AND p.id IS NULL
);

-- ALTER FK: añade ON DELETE CASCADE.
ALTER TABLE precios_compra_diarios
    DROP CONSTRAINT IF EXISTS precios_compra_diarios_pedido_id_fkey;

ALTER TABLE precios_compra_diarios
    ADD CONSTRAINT precios_compra_diarios_pedido_id_fkey
    FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE;

-- POST-CHECK: 0 huérfanos restantes + constraint registrada.
SELECT
    COUNT(*) AS huerfanos_restantes
FROM precios_compra_diarios pcd
LEFT JOIN pedidos p ON p.id = pcd.pedido_id
WHERE pcd.pedido_id IS NOT NULL
  AND p.id IS NULL;

SELECT conname, confdeltype
FROM pg_constraint
WHERE conname = 'precios_compra_diarios_pedido_id_fkey';
-- confdeltype = 'c' significa CASCADE.

COMMIT;
