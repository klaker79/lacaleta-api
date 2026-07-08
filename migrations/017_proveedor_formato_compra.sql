-- Migration 017: Formato de compra por proveedor en ingredientes_proveedores
--
-- Contexto: hasta ahora la pivote `ingredientes_proveedores` guardaba UN solo
-- número `precio` por proveedor y se asumía SIEMPRE en la unidad base del
-- ingrediente. Cuando dos proveedores venden el MISMO ingrediente en formatos
-- distintos (ej.: uno por docena, otro por caja de 15 bolsas × 6 uds), no había
-- forma de representarlo: el comparador "mejor precio" mezclaba peras con
-- manzanas y "marcar como principal" podía sincronizar el precio de una caja
-- como si fuera €/unidad-base, corrompiendo el escandallo.
--
-- DISEÑO NO-DESTRUCTIVO:
--
-- 1. Columnas OPCIONALES (DEFAULT NULL). Las filas existentes NO cambian: siguen
--    interpretando `precio` como €/unidad-base, exactamente como hoy. Sin backfill.
--
-- 2. `precio` SIGUE SIENDO EL CANÓNICO en €/unidad-base. Todo lo que lo lee o
--    escribe (IngredientService, COGS mensual en monthly.routes, sync a
--    ingredientes.precio, análisis del modal, updatePrincipalSupplierPrice tras
--    aprobar una compra) NO cambia de semántica.
--
-- 3. Cuando se informa un formato, el backend DERIVA
--    precio = precio_formato / cantidad_por_formato  (→ €/unidad-base)
--    y lo guarda en `precio`. Los tres campos nuevos solo memorizan "cómo lo
--    compro" para mostrarlo y reeditarlo.
--
-- 4. Constraints defensivas: cantidad > 0 y precio_formato >= 0.
--
-- NOTA: el mecanismo canónico de aplicación es src/db/init.js (bloque
-- "Migración 017"), idempotente en cada arranque. Este .sql es la copia
-- documental/manual equivalente.

ALTER TABLE ingredientes_proveedores
    ADD COLUMN IF NOT EXISTS formato VARCHAR(100),
    ADD COLUMN IF NOT EXISTS cantidad_por_formato NUMERIC(12,4)
        CHECK (cantidad_por_formato IS NULL OR cantidad_por_formato > 0),
    ADD COLUMN IF NOT EXISTS precio_formato NUMERIC(12,2)
        CHECK (precio_formato IS NULL OR precio_formato >= 0);

COMMENT ON COLUMN ingredientes_proveedores.formato IS
    'Nombre del formato de compra de ESTE proveedor (ej: caja, bolsa). Solo memoria de entrada; el precio comparable canónico vive en `precio` (€/unidad-base).';
COMMENT ON COLUMN ingredientes_proveedores.cantidad_por_formato IS
    'Cuántas unidades base trae el formato (ej: 7.5 docenas por caja). Usado para derivar `precio` = precio_formato / cantidad_por_formato.';
COMMENT ON COLUMN ingredientes_proveedores.precio_formato IS
    'Precio del formato completo tal como lo factura el proveedor (ej: € por caja). Solo display/reedición; NO se usa directamente en food cost.';
