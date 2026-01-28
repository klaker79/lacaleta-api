-- ============================================
-- Migration: 001_add_performance_indexes.sql
-- ============================================
--
-- Índices para optimizar queries frecuentes.
-- Ejecutar: psql -d lacaleta -f migrations/001_add_performance_indexes.sql
--
-- @author MindLoopIA
-- @date 2026-01-28

-- ============================================
-- VENTAS - Índices para analytics
-- ============================================

CREATE INDEX IF NOT EXISTS idx_ventas_fecha
ON ventas(fecha) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ventas_restaurante_fecha
ON ventas(restaurante_id, fecha) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ventas_receta
ON ventas(receta_id) WHERE deleted_at IS NULL;

-- ============================================
-- INGREDIENTES - Índices para stock
-- ============================================

CREATE INDEX IF NOT EXISTS idx_ingredientes_restaurante
ON ingredientes(restaurante_id) WHERE activo = true;

CREATE INDEX IF NOT EXISTS idx_ingredientes_stock_bajo
ON ingredientes(restaurante_id, stock_actual, stock_minimo)
WHERE activo = true AND stock_actual <= stock_minimo;

CREATE INDEX IF NOT EXISTS idx_ingredientes_familia
ON ingredientes(restaurante_id, familia) WHERE activo = true;

-- ============================================
-- RECETAS - Índices para lookups
-- ============================================

CREATE INDEX IF NOT EXISTS idx_recetas_restaurante
ON recetas(restaurante_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_recetas_categoria
ON recetas(restaurante_id, categoria) WHERE deleted_at IS NULL;

-- ============================================
-- MERMAS - Índices para reporting
-- ============================================

CREATE INDEX IF NOT EXISTS idx_mermas_fecha
ON mermas(restaurante_id, fecha);

CREATE INDEX IF NOT EXISTS idx_mermas_periodo
ON mermas(restaurante_id, periodo_id);

-- ============================================
-- HORARIOS - Índices para consultas de semana
-- ============================================

CREATE INDEX IF NOT EXISTS idx_horarios_semana
ON horarios(restaurante_id, fecha_inicio, fecha_fin);

-- ============================================
-- PEDIDOS - Índices para tracking
-- ============================================

CREATE INDEX IF NOT EXISTS idx_pedidos_estado
ON pedidos(restaurante_id, estado);

CREATE INDEX IF NOT EXISTS idx_pedidos_fecha
ON pedidos(restaurante_id, fecha_recepcion);

-- ============================================
-- Refresh stats
-- ============================================
ANALYZE ventas;
ANALYZE ingredientes;
ANALYZE recetas;
ANALYZE mermas;
