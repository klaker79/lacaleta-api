-- ============================================================================
-- smoke-test-tenant.sql
-- ----------------------------------------------------------------------------
-- Verifica que un tenant quedó COHERENTE tras alta nueva o import masivo.
-- Si todos los checks devuelven 0 → la cuenta está limpia para empezar a
-- venderse. Si alguno > 0 → revisar los ítems del campo `detalle` antes
-- de entregar la cuenta al cliente (regla post-incidente A TABOA + tanda
-- de bugs de import 2026-05-29/30/31).
--
-- Uso (vía docker exec contra el contenedor de Postgres):
--
--   docker exec <pg_container> psql -U <user> -d <db> \
--     -v rest_id=<RESTAURANTE_ID> -f scripts/smoke-test-tenant.sql
--
-- Ejemplo staging:
--   docker exec $(docker ps -q -f name=mindloopstagingdb) \
--     psql -U mindloop_staging_admin -d mindloop_staging \
--     -v rest_id=1 -f scripts/smoke-test-tenant.sql
--
-- Devuelve UNA fila por check:
--   check_name          : qué se está comprobando
--   items_problematicos : 0 = todo bien, >0 = revisar
--   detalle             : hasta 10 ítems afectados (id:nombre + contexto)
-- ============================================================================

WITH

-- Check 1: ingredientes con proveedor_id pero SIN fila en la pivot.
-- Origen del bug: el import de ingredientes no rellenaba ingredientes_proveedores
-- → el desplegable de pedidos (que filtra por la pivot) NO los veía aunque
-- visualmente tuvieran "su" proveedor. Fix de código aplicado 2026-05-31.
ingredientes_huerfanos_pivot AS (
    SELECT
        'INGREDIENTES_HUERFANOS_PIVOT' AS check_name,
        COUNT(*)::int AS items_problematicos,
        (ARRAY_AGG(i.id::text || ':' || i.nombre))[1:10] AS detalle
    FROM ingredientes i
    WHERE i.restaurante_id = :rest_id
      AND i.deleted_at IS NULL
      AND i.proveedor_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM ingredientes_proveedores ip WHERE ip.ingrediente_id = i.id
      )
),

-- Check 2: stock_actual altísimo combinado con cantidad_por_formato > 1.
-- Síntoma clásico de doble-multiplicación al recepcionar pedidos
-- (incidente 22-abril). En cuentas nuevas cpf=1 siempre.
-- Solo dispara si el ingrediente está en alguna receta (si no se cocina,
-- no afecta food cost; productos fungibles como guantes/toallitas/mantelillos
-- pueden tener stock alto + cpf grande legítimamente).
stock_posible_doble_mult AS (
    SELECT
        'STOCK_POSIBLE_DOBLE_MULTIPLICACION' AS check_name,
        COUNT(*)::int AS items_problematicos,
        (ARRAY_AGG(
            i.id::text || ':' || i.nombre
            || ' (stock=' || i.stock_actual::text
            || ', cpf=' || i.cantidad_por_formato::text || ')'
        ))[1:10] AS detalle
    FROM ingredientes i
    WHERE i.restaurante_id = :rest_id
      AND i.deleted_at IS NULL
      AND i.stock_actual > 1000
      AND COALESCE(i.cantidad_por_formato, 1) > 1
      AND EXISTS (
          SELECT 1 FROM recetas r
          CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(r.ingredientes) = 'array'
                   THEN r.ingredientes ELSE '[]'::jsonb END
          ) AS elem_chk
          WHERE r.restaurante_id = :rest_id
            AND r.deleted_at IS NULL
            AND (elem_chk->>'ingredienteId') ~ '^[0-9]+$'
            AND (elem_chk->>'ingredienteId')::int = i.id
      )
),

-- Check 3: stock_actual negativo. Nunca debería existir (GREATEST(0,...) en
-- todos los UPDATEs de stock). Si aparece, algo se saltó la guardia.
stock_negativo AS (
    SELECT
        'STOCK_NEGATIVO' AS check_name,
        COUNT(*)::int AS items_problematicos,
        (ARRAY_AGG(i.id::text || ':' || i.nombre || ' (' || i.stock_actual::text || ')'))[1:10] AS detalle
    FROM ingredientes i
    WHERE i.restaurante_id = :rest_id
      AND i.deleted_at IS NULL
      AND i.stock_actual < 0
),

-- Check 4: nombres de ingrediente duplicados (case-insensitive, trim).
-- Fragmentan stock/precios/búsqueda y rompen el matching del import de
-- escandallo. Ver feedback_ingrediente_fragmentation.
ingredientes_duplicados AS (
    SELECT
        'INGREDIENTES_NOMBRE_DUPLICADO' AS check_name,
        COUNT(*)::int AS items_problematicos,
        (ARRAY_AGG(clave || ' → ids: ' || ids_text))[1:10] AS detalle
    FROM (
        SELECT
            LOWER(TRIM(nombre)) AS clave,
            STRING_AGG(id::text, ', ' ORDER BY id) AS ids_text
        FROM ingredientes
        WHERE restaurante_id = :rest_id AND deleted_at IS NULL
        GROUP BY LOWER(TRIM(nombre))
        HAVING COUNT(*) > 1
    ) dup
),

-- Check 5: recetas con líneas cuyo ingredienteId no existe (huérfanas).
-- Suelen aparecer cuando se borra un ingrediente pero las recetas que lo
-- usaban no se limpian, o por imports con ids inventados.
recetas_con_ings_invalidos AS (
    SELECT
        'RECETAS_CON_INGS_INVALIDOS' AS check_name,
        COUNT(DISTINCT r.id)::int AS items_problematicos,
        (ARRAY_AGG(DISTINCT r.id::text || ':' || r.nombre))[1:10] AS detalle
    FROM recetas r
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(r.ingredientes) = 'array' THEN r.ingredientes ELSE '[]'::jsonb END
    ) AS elem
    WHERE r.restaurante_id = :rest_id
      AND r.deleted_at IS NULL
      AND (elem->>'ingredienteId') ~ '^[0-9]+$'
      AND (elem->>'ingredienteId')::int < 100000  -- excluir subrecetas
      AND NOT EXISTS (
          SELECT 1 FROM ingredientes i
          WHERE i.id = (elem->>'ingredienteId')::int
            AND i.restaurante_id = :rest_id
            AND i.deleted_at IS NULL
      )
),

-- Check 6: recetas sin escandallo (ingredientes vacío) en categorías
-- que SÍ deberían tenerlo (no base ni bebidas — esas a veces lo llevan vacío).
recetas_sin_escandallo AS (
    SELECT
        'RECETAS_SIN_ESCANDALLO' AS check_name,
        COUNT(*)::int AS items_problematicos,
        (ARRAY_AGG(r.id::text || ':' || r.nombre))[1:10] AS detalle
    FROM recetas r
    WHERE r.restaurante_id = :rest_id
      AND r.deleted_at IS NULL
      AND LOWER(COALESCE(r.categoria, '')) NOT IN ('base', 'bebidas', 'bebida')
      AND (r.ingredientes IS NULL
           OR jsonb_typeof(r.ingredientes) != 'array'
           OR jsonb_array_length(r.ingredientes) = 0)
),

-- Check 7: cantidad_por_formato != 1 (regla cuentas nuevas Stefania/Iker:
-- siempre 1 al crearse; otros valores aparecen solo si se editó manualmente).
ingredientes_cpf_no_uno AS (
    SELECT
        'INGREDIENTES_CPF_DISTINTO_DE_1' AS check_name,
        COUNT(*)::int AS items_problematicos,
        (ARRAY_AGG(i.id::text || ':' || i.nombre || ' (cpf=' || i.cantidad_por_formato::text || ')'))[1:10] AS detalle
    FROM ingredientes i
    WHERE i.restaurante_id = :rest_id
      AND i.deleted_at IS NULL
      AND i.cantidad_por_formato IS NOT NULL
      AND i.cantidad_por_formato != 1
),

-- Check 8: ingredientes con más de un "proveedor principal" en la pivot.
-- Origen del bug project_proveedor_principal_duplicado_2026_05_28: el endpoint
-- de añadir 2º proveedor principal no desmarcaba el anterior → totales inflados.
proveedor_principal_duplicado AS (
    SELECT
        'INGREDIENTE_CON_2+_PROVEEDORES_PRINCIPALES' AS check_name,
        COUNT(*)::int AS items_problematicos,
        (ARRAY_AGG(i.nombre || ' (ing_id=' || ing_id::text || ', ' || cnt::text || ' principales)'))[1:10] AS detalle
    FROM (
        SELECT
            ip.ingrediente_id AS ing_id,
            COUNT(*) AS cnt
        FROM ingredientes_proveedores ip
        JOIN ingredientes i_inner ON i_inner.id = ip.ingrediente_id
        WHERE i_inner.restaurante_id = :rest_id
          AND i_inner.deleted_at IS NULL
          AND ip.es_proveedor_principal = TRUE
        GROUP BY ip.ingrediente_id
        HAVING COUNT(*) > 1
    ) sub
    JOIN ingredientes i ON i.id = sub.ing_id
)

SELECT * FROM ingredientes_huerfanos_pivot
UNION ALL SELECT * FROM stock_posible_doble_mult
UNION ALL SELECT * FROM stock_negativo
UNION ALL SELECT * FROM ingredientes_duplicados
UNION ALL SELECT * FROM recetas_con_ings_invalidos
UNION ALL SELECT * FROM recetas_sin_escandallo
UNION ALL SELECT * FROM ingredientes_cpf_no_uno
UNION ALL SELECT * FROM proveedor_principal_duplicado
ORDER BY items_problematicos DESC, check_name;
