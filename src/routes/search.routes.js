/**
 * Search Routes — flexible sales/purchases lookup with filters
 *
 * GET /api/search
 *   Query params:
 *     - tipo: 'ventas' | 'compras'   (required)
 *     - desde: YYYY-MM-DD            (required, inclusive)
 *     - hasta: YYYY-MM-DD            (required, exclusive — typically 1st of next month)
 *     - q: string                    (optional, case-insensitive match on recipe/ingredient name)
 *     - proveedor_id: int            (optional, filter purchases by supplier)
 *     - limit: 1..2000               (optional, default 500)
 *
 *   Returns JSON with the period, totals and the rows.
 *
 * Designed for the "Búsqueda" tab in the frontend. Kept separate from /sales
 * and /orders because the shape of the response is tailored to what the UI
 * needs: one row per item (sale or purchase line), flat, Excel-exportable.
 *
 * Multi-tenant: restauranteId comes from the JWT (authMiddleware).
 * No plan-gate: search is a basic feature available to every tenant.
 */

const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { log } = require('../utils/logger');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value, fieldName) {
    if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
        const err = new Error(`${fieldName} must be YYYY-MM-DD (received: ${value})`);
        err.status = 400;
        throw err;
    }
    return value;
}

function clampLimit(raw) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return 500;
    return Math.min(n, 2000);
}

module.exports = function (pool) {
    const router = Router();

    router.get('/search', authMiddleware, async (req, res) => {
        try {
            const { tipo, desde, hasta, q, proveedor_id } = req.query;
            const restauranteId = req.restauranteId;

            if (tipo !== 'ventas' && tipo !== 'compras') {
                return res.status(400).json({ error: 'tipo must be "ventas" or "compras"' });
            }

            const desdeDate = parseIsoDate(desde, 'desde');
            const hastaDate = parseIsoDate(hasta, 'hasta');

            // Sanity: desde < hasta
            if (desdeDate >= hastaDate) {
                return res.status(400).json({ error: 'desde must be strictly before hasta' });
            }

            const limit = clampLimit(req.query.limit);
            const qLike = typeof q === 'string' && q.trim() ? `%${q.trim().toLowerCase()}%` : null;
            const provId = proveedor_id ? parseInt(proveedor_id, 10) : null;

            if (tipo === 'ventas') {
                // One row per sale line with recipe name + category
                const params = [restauranteId, desdeDate, hastaDate];
                let where = 'v.restaurante_id = $1 AND v.fecha >= $2 AND v.fecha < $3 AND v.deleted_at IS NULL';
                if (qLike) {
                    params.push(qLike);
                    where += ` AND LOWER(r.nombre) LIKE $${params.length}`;
                }
                params.push(limit);
                const rowsQuery = `
                    SELECT
                        v.id,
                        v.fecha,
                        v.receta_id,
                        r.nombre AS receta_nombre,
                        r.categoria,
                        v.cantidad,
                        v.precio_unitario,
                        v.total
                    FROM ventas v
                    LEFT JOIN recetas r ON v.receta_id = r.id
                    WHERE ${where}
                    ORDER BY v.fecha DESC, v.id DESC
                    LIMIT $${params.length}
                `;
                const rows = (await pool.query(rowsQuery, params)).rows;

                // Aggregate totals over the full matching set (not just the limit).
                // We need the restauranteId + dates + optional q; drop the limit param.
                const aggParams = [restauranteId, desdeDate, hastaDate];
                let aggWhere = 'v.restaurante_id = $1 AND v.fecha >= $2 AND v.fecha < $3 AND v.deleted_at IS NULL';
                if (qLike) {
                    aggParams.push(qLike);
                    aggWhere += ` AND LOWER(r.nombre) LIKE $${aggParams.length}`;
                }
                const aggQuery = `
                    SELECT
                        COUNT(*)::int AS total_registros,
                        COALESCE(SUM(v.total), 0)::numeric(12,2) AS total_importe,
                        COALESCE(SUM(v.cantidad), 0)::numeric(12,2) AS total_cantidad
                    FROM ventas v
                    LEFT JOIN recetas r ON v.receta_id = r.id
                    WHERE ${aggWhere}
                `;
                const agg = (await pool.query(aggQuery, aggParams)).rows[0];

                return res.json({
                    tipo: 'ventas',
                    periodo: { desde: desdeDate, hasta: hastaDate },
                    filtro: { q: q || null },
                    total_registros: agg.total_registros,
                    total_importe: parseFloat(agg.total_importe),
                    total_cantidad: parseFloat(agg.total_cantidad),
                    limit_aplicado: limit,
                    truncado: agg.total_registros > rows.length,
                    resultados: rows
                });
            }

            // tipo === 'compras': flatten purchase lines from pedidos.ingredientes jsonb
            const params = [restauranteId, desdeDate, hastaDate];
            let where = 'p.restaurante_id = $1 AND p.fecha >= $2 AND p.fecha < $3 AND p.deleted_at IS NULL';
            if (provId) {
                // Match explicit proveedor OR fallback to the ingredient's main supplier
                // (same attribution rule used in /monthly/summary).
                params.push(provId);
                where += ` AND COALESCE(p.proveedor_id, ip_fb.proveedor_id) = $${params.length}`;
            }
            if (qLike) {
                params.push(qLike);
                where += ` AND LOWER(i.nombre) LIKE $${params.length}`;
            }
            params.push(limit);
            // precioReal and precioUnitario in the JSONB are UNIT prices.
            // Subtotal must be cantidad (received || ordered) × unit price.
            // Lines marked 'no-entregado' count as 0 to match the pedido detail UI.
            //
            // Proveedor: si el pedido no tiene proveedor_id, se atribuye al
            // proveedor PRINCIPAL del ingrediente (ingredientes_proveedores).
            // Misma regla que usa /monthly/summary → dashboard Top Proveedores.
            // Así Búsqueda y Dashboard cuadran al céntimo.
            const rowsQuery = `
                SELECT
                    p.id AS pedido_id,
                    p.fecha,
                    p.estado,
                    COALESCE(pr.nombre, pr_fb.nombre, '(sin proveedor)') AS proveedor_nombre,
                    COALESCE(p.proveedor_id, ip_fb.proveedor_id) AS proveedor_id,
                    i.id AS ingrediente_id,
                    i.nombre AS ingrediente_nombre,
                    i.unidad,
                    COALESCE((ing->>'cantidadRecibida')::numeric, (ing->>'cantidad')::numeric) AS cantidad,
                    COALESCE((ing->>'precioReal')::numeric,
                             (ing->>'precioUnitario')::numeric,
                             (ing->>'precio_unitario')::numeric) AS precio_unitario,
                    CASE WHEN ing->>'estado' = 'no-entregado' THEN 0 ELSE
                        COALESCE((ing->>'cantidadRecibida')::numeric, (ing->>'cantidad')::numeric) *
                        COALESCE((ing->>'precioReal')::numeric,
                                 (ing->>'precioUnitario')::numeric,
                                 (ing->>'precio_unitario')::numeric)
                    END AS subtotal
                FROM pedidos p
                LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
                CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.ingredientes, '[]'::jsonb)) AS ing
                LEFT JOIN ingredientes i
                    ON i.id = COALESCE((ing->>'ingredienteId')::int, (ing->>'ingrediente_id')::int)
                LEFT JOIN ingredientes_proveedores ip_fb
                    ON ip_fb.ingrediente_id = i.id AND ip_fb.es_proveedor_principal = TRUE
                LEFT JOIN proveedores pr_fb
                    ON pr_fb.id = ip_fb.proveedor_id AND p.proveedor_id IS NULL
                WHERE ${where}
                ORDER BY p.fecha DESC, p.id DESC
                LIMIT $${params.length}
            `;
            const rows = (await pool.query(rowsQuery, params)).rows;

            // Aggregate — count distinct pedidos and sum subtotals
            const aggParams = [restauranteId, desdeDate, hastaDate];
            let aggWhere = 'p.restaurante_id = $1 AND p.fecha >= $2 AND p.fecha < $3 AND p.deleted_at IS NULL';
            if (provId) {
                aggParams.push(provId);
                aggWhere += ` AND COALESCE(p.proveedor_id, ip_fb.proveedor_id) = $${aggParams.length}`;
            }
            // If q filter is applied, aggregate only lines that match
            let aggQuery;
            if (qLike) {
                aggParams.push(qLike);
                aggQuery = `
                    SELECT
                        COUNT(DISTINCT p.id)::int AS num_pedidos,
                        COUNT(*)::int AS total_registros,
                        COALESCE(SUM(
                            CASE WHEN ing->>'estado' = 'no-entregado' THEN 0 ELSE
                                COALESCE((ing->>'cantidadRecibida')::numeric, (ing->>'cantidad')::numeric) *
                                COALESCE((ing->>'precioReal')::numeric,
                                         (ing->>'precioUnitario')::numeric,
                                         (ing->>'precio_unitario')::numeric)
                            END
                        ), 0)::numeric(12,2) AS total_importe
                    FROM pedidos p
                    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.ingredientes, '[]'::jsonb)) AS ing
                    LEFT JOIN ingredientes i
                        ON i.id = COALESCE((ing->>'ingredienteId')::int, (ing->>'ingrediente_id')::int)
                    LEFT JOIN ingredientes_proveedores ip_fb
                        ON ip_fb.ingrediente_id = i.id AND ip_fb.es_proveedor_principal = TRUE
                    WHERE ${aggWhere} AND LOWER(i.nombre) LIKE $${aggParams.length}
                `;
            } else if (provId) {
                // When filtering by proveedor (with fallback), need the JOIN too
                aggQuery = `
                    SELECT
                        COUNT(DISTINCT p.id)::int AS num_pedidos,
                        COUNT(*)::int AS total_registros,
                        COALESCE(SUM(
                            CASE WHEN ing->>'estado' = 'no-entregado' THEN 0 ELSE
                                COALESCE((ing->>'cantidadRecibida')::numeric, (ing->>'cantidad')::numeric) *
                                COALESCE((ing->>'precioReal')::numeric,
                                         (ing->>'precioUnitario')::numeric,
                                         (ing->>'precio_unitario')::numeric)
                            END
                        ), 0)::numeric(12,2) AS total_importe
                    FROM pedidos p
                    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.ingredientes, '[]'::jsonb)) AS ing
                    LEFT JOIN ingredientes i
                        ON i.id = COALESCE((ing->>'ingredienteId')::int, (ing->>'ingrediente_id')::int)
                    LEFT JOIN ingredientes_proveedores ip_fb
                        ON ip_fb.ingrediente_id = i.id AND ip_fb.es_proveedor_principal = TRUE
                    WHERE ${aggWhere}
                `;
            } else {
                aggQuery = `
                    SELECT
                        COUNT(DISTINCT p.id)::int AS num_pedidos,
                        COUNT(*)::int AS total_registros,
                        COALESCE(SUM(p.total), 0)::numeric(12,2) AS total_importe
                    FROM pedidos p
                    WHERE ${aggWhere}
                `;
            }
            const agg = (await pool.query(aggQuery, aggParams)).rows[0];

            return res.json({
                tipo: 'compras',
                periodo: { desde: desdeDate, hasta: hastaDate },
                filtro: { q: q || null, proveedor_id: provId },
                num_pedidos: agg.num_pedidos,
                total_registros: agg.total_registros,
                total_importe: parseFloat(agg.total_importe),
                limit_aplicado: limit,
                truncado: agg.total_registros > rows.length,
                resultados: rows
            });
        } catch (err) {
            if (err.status === 400) {
                return res.status(400).json({ error: err.message });
            }
            log('error', 'Search endpoint failed', {
                error: err.message,
                stack: err.stack,
                restauranteId: req.restauranteId,
                query: req.query
            });
            return res.status(500).json({ error: 'Search failed' });
        }
    });

    return router;
};
