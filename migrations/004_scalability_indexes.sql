-- ============================================
-- Migration: 004_scalability_indexes.sql
-- ============================================
--
-- Índices compuestos para escalabilidad multi-tenant.
-- Optimiza las queries más frecuentes cuando hay múltiples restaurantes.
--
-- Ejecutar: psql -d lacaleta -f migrations/004_scalability_indexes.sql
--
-- Nota: idx_ventas_restaurante_fecha ya existe en 001_add_performance_indexes.sql
-- y cubre las queries de ventas con (restaurante_id, fecha) WHERE deleted_at IS NULL.
--
-- @date 2026-02-08

-- ============================================
-- PEDIDOS - Índice para GET /api/orders
-- ============================================
-- Query: SELECT * FROM pedidos WHERE restaurante_id=$1 AND deleted_at IS NULL ORDER BY fecha DESC
-- El índice existente idx_pedidos_fecha usa fecha_recepcion, no fecha.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pedidos_rest_fecha
ON pedidos(restaurante_id, fecha DESC) WHERE deleted_at IS NULL;

-- ============================================
-- PRECIOS COMPRA DIARIOS - Índice para lookups por fecha
-- ============================================
-- Query: WHERE restaurante_id=$1 AND fecha::date=...
-- Sin índice previo en esta tabla.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_precios_rest_fecha
ON precios_compra_diarios(restaurante_id, fecha);

-- ============================================
-- Refresh stats
-- ============================================
ANALYZE pedidos;
ANALYZE precios_compra_diarios;
