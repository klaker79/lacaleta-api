-- ════════════════════════════════════════════════════
-- 📈 Performance Indexes — Phase 3
-- ════════════════════════════════════════════════════
-- Composite indexes identified by CostOS analysis as missing.
-- These cover the most frequently queried patterns in reporting,
-- menu engineering, and operational endpoints.

-- Ventas: JOIN frecuente en menu-engineering y balance
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ventas_restaurante_receta_fecha 
ON ventas (restaurante_id, receta_id, fecha) WHERE deleted_at IS NULL;

-- Ingredientes-Proveedores: consultas de proveedores con sus ingredientes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ingredientes_proveedores_proveedor 
ON ingredientes_proveedores (proveedor_id);

-- Compras pendientes: listado de cola de revisión
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_compras_pendientes_estado 
ON compras_pendientes (restaurante_id, created_at) WHERE estado = 'pendiente';

-- Ventas diarias resumen: resumen mensual y P&L
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ventas_diarias_resumen_restaurante_fecha 
ON ventas_diarias_resumen (restaurante_id, fecha);

-- Gastos fijos: listado filtrado activos
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gastos_fijos_activos 
ON gastos_fijos (restaurante_id) WHERE activo = true;

-- API tokens: listado por restaurante
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_api_tokens_restaurante 
ON api_tokens (restaurante_id);
