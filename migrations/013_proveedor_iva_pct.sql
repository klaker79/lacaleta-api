-- Migration 013: IVA habitual por proveedor
--
-- Añade columna `iva_pct` a la tabla `proveedores` para memorizar el IVA
-- típico de cada proveedor y autorellenarlo en el modal de recepción de
-- pedido. Decisión Iker 2026-06-06: el cliente apunta los precios netos
-- en la app, pero el albarán físico viene con IVA aparte; necesita ver
-- "Total + IVA" en el modal de recepción para cuadrar con el albarán.
--
-- DISEÑO RIGUROSO DE NO-CONTAMINACIÓN:
--
-- 1. El IVA NO se persiste en pedidos ni en precios_compra_diarios.
--    Solo es display en el modal de recepción.
--
-- 2. El IVA NO afecta a `precio_medio_compra`, `precio_unitario`,
--    food cost, COGS, P&L ni a ninguna fórmula crítica. Estos campos
--    siguen siendo NETOS (sin IVA) como hasta ahora.
--
-- 3. La columna `iva_pct` es opcional (DEFAULT NULL). Los proveedores
--    existentes no se rompen — el campo se interpreta como "no
--    configurado" y el modal de recepción pone el selector en 0%
--    por defecto.
--
-- 4. Constraint: 0 <= iva_pct <= 100, para evitar valores absurdos.
--
-- Backfill: ninguno. Tenants existentes verán NULL hasta configurar.

ALTER TABLE proveedores
    ADD COLUMN IF NOT EXISTS iva_pct NUMERIC(5,2)
        CHECK (iva_pct IS NULL OR (iva_pct >= 0 AND iva_pct <= 100));

COMMENT ON COLUMN proveedores.iva_pct IS
    'IVA habitual del proveedor en porcentaje (0-100). Solo display en el modal de recepción para cuadrar con el albarán físico. NO se aplica a precio_medio_compra ni a ninguna fórmula crítica.';
