-- Migration 010: UNIQUE INDEX parcial — un único proveedor principal por ingrediente
--
-- Contexto (project_proveedor_principal_duplicado_2026_05_28):
--   Cuando un ingrediente tenía 2+ filas en ingredientes_proveedores con
--   es_proveedor_principal=TRUE, cualquier endpoint que atribuyera compras
--   vía LEFT JOIN ... es_proveedor_principal=TRUE duplicaba las líneas y
--   inflaba los totales (afectó a Diario, Búsqueda, Top Proveedores).
--   El chat IA no se afectaba porque sumaba pedidos.total directo.
--
--   Caso real La Nave 5 (mar 2026): Petiscos do Mar vs Mardelia ambos
--   marcados como principales para MEJILLON y PERCEBES.
--
-- Esta migration:
--   1. Reporta duplicados existentes (PRE-CHECK).
--   2. Deja un único principal por ingrediente: el de created_at más
--      reciente (asunción: el último que el usuario quiso marcar).
--   3. Crea índice único parcial → impide físicamente 2 principales.
--
-- Estrategia de limpieza: en duplicados, ganador = MAX(created_at), perdedor
-- queda como secundario (es_proveedor_principal=FALSE). NO se borra ninguna
-- relación. Si Iker quiere otro ganador en algún caso, lo edita post-migration.
--
-- IDEMPOTENTE: el SELECT pre-check no muta nada, el UPDATE solo afecta a duplicados
-- (si no hay, no toca nada), el CREATE UNIQUE INDEX usa IF NOT EXISTS.

BEGIN;

-- PRE-CHECK 1: ¿hay duplicados?
-- Esperado tras limpieza: 0 filas.
SELECT
    i.restaurante_id,
    ip.ingrediente_id,
    i.nombre AS ingrediente,
    COUNT(*) AS num_principales,
    ARRAY_AGG(ip.id ORDER BY ip.created_at DESC) AS ids_filas,
    ARRAY_AGG(ip.proveedor_id ORDER BY ip.created_at DESC) AS proveedores_ids
FROM ingredientes_proveedores ip
JOIN ingredientes i ON i.id = ip.ingrediente_id
WHERE ip.es_proveedor_principal = TRUE
GROUP BY i.restaurante_id, ip.ingrediente_id, i.nombre
HAVING COUNT(*) > 1
ORDER BY i.restaurante_id, i.nombre;

-- LIMPIEZA: para cada ingrediente con >1 principal, conserva el más reciente.
WITH ranked AS (
    SELECT
        ip.id,
        ROW_NUMBER() OVER (
            PARTITION BY ip.ingrediente_id
            ORDER BY ip.created_at DESC, ip.id DESC
        ) AS rn
    FROM ingredientes_proveedores ip
    WHERE ip.es_proveedor_principal = TRUE
)
UPDATE ingredientes_proveedores
SET es_proveedor_principal = FALSE
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- INDEX defensivo: impide físicamente que vuelvan a aparecer 2 principales.
-- Parcial: solo aplica a filas con es_proveedor_principal=TRUE.
-- ingrediente_id ya es único entre tenants (cada ingrediente pertenece a un tenant).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ingredientes_proveedores_principal_unico
ON ingredientes_proveedores (ingrediente_id)
WHERE es_proveedor_principal = TRUE;

-- POST-CHECK: confirmar 0 duplicados y que el índice existe.
SELECT
    COUNT(*) AS duplicados_restantes
FROM (
    SELECT ip.ingrediente_id
    FROM ingredientes_proveedores ip
    WHERE ip.es_proveedor_principal = TRUE
    GROUP BY ip.ingrediente_id
    HAVING COUNT(*) > 1
) d;

SELECT indexname FROM pg_indexes
WHERE tablename = 'ingredientes_proveedores'
  AND indexname = 'uq_ingredientes_proveedores_principal_unico';

COMMIT;
