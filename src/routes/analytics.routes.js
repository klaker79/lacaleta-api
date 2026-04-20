/**
 * Analytics Routes — food cost, P&L breakdown, COGS recalculation.
 *
 * Extracted from balance.routes.js on 2026-04-20 to keep that file under
 * a manageable size. All endpoints here read/write ventas_diarias_resumen
 * as the book of record and are safe to expose from any panel that
 * wants consistent numbers across dashboard, diario and analysis tabs.
 *
 * Endpoints:
 *   - POST /analytics/recalculate-cogs   — admin-only, dry-run by default
 *   - GET  /analytics/pnl-breakdown      — food / beverage / otros buckets
 *   - GET  /analytics/food-cost          — legacy single bucket (kept for BC)
 */

const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { costlyApiLimiter } = require('../middleware/rateLimit');
const { log } = require('../utils/logger');

function defaultMesActual() {
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth();
    const pad = (n) => String(n).padStart(2, '0');
    const desde = `${y}-${pad(m + 1)}-01`;
    const nextM = m === 11 ? 1 : m + 2;
    const nextY = m === 11 ? y + 1 : y;
    const hasta = `${nextY}-${pad(nextM)}-01`;
    return { desde, hasta };
}

module.exports = function (pool) {
    const router = Router();

    /**
     * POST /analytics/recalculate-cogs
     * Body: { desde: 'YYYY-MM-DD', hasta: 'YYYY-MM-DD', apply?: boolean }
     *
     * Recomputes coste_ingredientes + beneficio_bruto for every row in
     * ventas_diarias_resumen in the date range using the CURRENT recipe
     * definitions + CURRENT ingredient prices + CURRENT rendimientos.
     *
     * Dry-run by default (apply: false). Pass apply: true to commit.
     */
    router.post('/analytics/recalculate-cogs', authMiddleware, requireAdmin, costlyApiLimiter, async (req, res) => {
        try {
            const { desde, hasta, apply = false } = req.body || {};
            if (!desde || !hasta) {
                return res.status(400).json({ error: 'desde y hasta son obligatorios (YYYY-MM-DD)' });
            }

            // 1. Individual ventas — preserves factor_variante per sale
            const { rows: ventasIndividuales } = await pool.query(
                `SELECT id, DATE(fecha) AS fecha, receta_id, cantidad, total,
                        variante_id, factor_variante
                 FROM ventas
                 WHERE restaurante_id = $1 AND deleted_at IS NULL
                   AND fecha >= $2 AND fecha < $3
                 ORDER BY fecha, id`,
                [req.restauranteId, desde, hasta]
            );
            if (ventasIndividuales.length === 0) {
                return res.json({ apply: false, total_rows: 0, rows_with_change: 0, changes_preview: [] });
            }

            // 2. Recipes referenced
            const recetaIds = [...new Set(ventasIndividuales.map(v => v.receta_id))];
            const { rows: recetas } = await pool.query(
                `SELECT id, nombre, ingredientes, porciones
                 FROM recetas
                 WHERE restaurante_id = $1 AND id = ANY($2::int[])`,
                [req.restauranteId, recetaIds]
            );
            const recetasMap = new Map(recetas.map(r => [r.id, r]));

            // 3. Ingredient prices + base rendimiento
            const { rows: ingredientes } = await pool.query(
                `SELECT i.id, i.precio, i.cantidad_por_formato, i.rendimiento,
                        pcd.precio_medio_compra
                 FROM ingredientes i
                 LEFT JOIN (
                     SELECT ingrediente_id, ROUND(AVG(precio_unitario)::numeric, 4) AS precio_medio_compra
                     FROM precios_compra_diarios
                     WHERE restaurante_id = $1
                     GROUP BY ingrediente_id
                 ) pcd ON pcd.ingrediente_id = i.id
                 WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL`,
                [req.restauranteId]
            );
            const preciosMap = new Map();
            const rendimientoBaseMap = new Map();
            for (const ing of ingredientes) {
                if (ing.precio_medio_compra) {
                    preciosMap.set(ing.id, parseFloat(ing.precio_medio_compra));
                } else {
                    const p = parseFloat(ing.precio) || 0;
                    const cpf = parseFloat(ing.cantidad_por_formato) || 1;
                    preciosMap.set(ing.id, cpf > 0 ? p / cpf : p);
                }
                if (ing.rendimiento) rendimientoBaseMap.set(ing.id, parseFloat(ing.rendimiento));
            }

            // 4. Pre-compute coste por porción de cada receta
            const costePorcionPorReceta = new Map();
            for (const receta of recetas) {
                const lineas = receta.ingredientes || [];
                const porciones = parseInt(receta.porciones) || 1;
                let cogsLote = 0;
                for (const item of lineas) {
                    const precio = preciosMap.get(item.ingredienteId) || 0;
                    let rendimiento = parseFloat(item.rendimiento);
                    if (!rendimiento) rendimiento = rendimientoBaseMap.get(item.ingredienteId) || 100;
                    const factor = rendimiento / 100;
                    const costeReal = factor > 0 ? (precio / factor) : precio;
                    cogsLote += costeReal * (parseFloat(item.cantidad) || 0);
                }
                costePorcionPorReceta.set(receta.id, cogsLote / porciones);
            }

            // 5. Recompute each individual venta and aggregate by (receta_id, fecha)
            const aggregados = new Map();
            for (const v of ventasIndividuales) {
                const cogsPorPorcion = costePorcionPorReceta.get(v.receta_id);
                if (cogsPorPorcion === undefined) continue;
                const cantidad = parseFloat(v.cantidad) || 0;
                const factorVariante = parseFloat(v.factor_variante) || 1;
                const costeVenta = cogsPorPorcion * cantidad * factorVariante;
                const fechaStr = v.fecha instanceof Date
                    ? v.fecha.toISOString().slice(0, 10)
                    : String(v.fecha).slice(0, 10);
                const key = `${v.receta_id}_${fechaStr}`;
                if (!aggregados.has(key)) {
                    aggregados.set(key, {
                        receta_id: v.receta_id,
                        fecha: fechaStr,
                        coste: 0,
                        ingresos: 0,
                        unidades: 0
                    });
                }
                const a = aggregados.get(key);
                a.coste += costeVenta;
                a.ingresos += parseFloat(v.total) || 0;
                a.unidades += cantidad;
            }

            // 6. Load current ventas_diarias_resumen rows
            const vdrKeys = [...aggregados.keys()];
            if (vdrKeys.length === 0) {
                return res.json({ apply: false, total_rows: 0, rows_with_change: 0, changes_preview: [] });
            }
            const recetaIdsAgg = [...new Set([...aggregados.values()].map(a => a.receta_id))];
            const { rows: vdrRows } = await pool.query(
                `SELECT id, receta_id, fecha::date AS fecha, cantidad_vendida,
                        total_ingresos, coste_ingredientes
                 FROM ventas_diarias_resumen
                 WHERE restaurante_id = $1 AND fecha >= $2 AND fecha < $3
                   AND receta_id = ANY($4::int[])`,
                [req.restauranteId, desde, hasta, recetaIdsAgg]
            );
            const vdrMap = new Map();
            for (const r of vdrRows) {
                const fechaStr = r.fecha instanceof Date
                    ? r.fecha.toISOString().slice(0, 10)
                    : String(r.fecha).slice(0, 10);
                vdrMap.set(`${r.receta_id}_${fechaStr}`, r);
            }

            // 7. Build list of changes
            const changes = [];
            let totalAntes = 0;
            let totalDespues = 0;
            for (const [key, a] of aggregados) {
                const vdr = vdrMap.get(key);
                if (!vdr) continue;
                const cogsAntes = parseFloat(vdr.coste_ingredientes) || 0;
                const cogsNuevo = Math.round(a.coste * 100) / 100;
                totalAntes += cogsAntes;
                totalDespues += cogsNuevo;
                if (Math.abs(cogsAntes - cogsNuevo) > 0.01) {
                    const receta = recetasMap.get(a.receta_id);
                    changes.push({
                        vdr_id: vdr.id,
                        fecha: a.fecha,
                        receta: receta ? receta.nombre : `(id ${a.receta_id})`,
                        unidades_vendidas: a.unidades,
                        ingresos: Math.round(a.ingresos * 100) / 100,
                        coste_antes: Math.round(cogsAntes * 100) / 100,
                        coste_despues: cogsNuevo,
                        diferencia: Math.round((cogsNuevo - cogsAntes) * 100) / 100
                    });
                }
            }

            // 8. Apply transactionally
            let applied = 0;
            if (apply === true && changes.length > 0) {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    for (const ch of changes) {
                        const r = await client.query(
                            `UPDATE ventas_diarias_resumen
                             SET coste_ingredientes = $1,
                                 beneficio_bruto = GREATEST(0, total_ingresos - $1)
                             WHERE id = $2 AND restaurante_id = $3`,
                            [ch.coste_despues, ch.vdr_id, req.restauranteId]
                        );
                        applied += r.rowCount || 0;
                    }
                    await client.query('COMMIT');
                } catch (err) {
                    await client.query('ROLLBACK');
                    throw err;
                } finally {
                    client.release();
                }
            }

            // 9. Agrupar por receta para inspección humana
            const porReceta = new Map();
            for (const ch of changes) {
                const key = ch.receta;
                if (!porReceta.has(key)) {
                    porReceta.set(key, {
                        receta: ch.receta,
                        dias_con_cambio: 0,
                        unidades_total: 0,
                        ingresos_total: 0,
                        coste_antes_total: 0,
                        coste_despues_total: 0
                    });
                }
                const g = porReceta.get(key);
                g.dias_con_cambio++;
                g.unidades_total += ch.unidades_vendidas;
                g.ingresos_total += ch.ingresos;
                g.coste_antes_total += ch.coste_antes;
                g.coste_despues_total += ch.coste_despues;
            }
            const changes_by_receta = [...porReceta.values()]
                .map(g => ({
                    receta: g.receta,
                    dias_con_cambio: g.dias_con_cambio,
                    unidades_total: g.unidades_total,
                    ingresos_total: Math.round(g.ingresos_total * 100) / 100,
                    coste_antes_total: Math.round(g.coste_antes_total * 100) / 100,
                    coste_despues_total: Math.round(g.coste_despues_total * 100) / 100,
                    diferencia: Math.round((g.coste_despues_total - g.coste_antes_total) * 100) / 100
                }))
                .sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));

            return res.json({
                apply: apply === true,
                periodo: { desde, hasta },
                ventas_individuales_analizadas: ventasIndividuales.length,
                filas_vdr_analizadas: vdrRows.length,
                rows_with_change: changes.length,
                applied_rows: applied,
                coste_total_antes: Math.round(totalAntes * 100) / 100,
                coste_total_despues: Math.round(totalDespues * 100) / 100,
                diferencia: Math.round((totalDespues - totalAntes) * 100) / 100,
                changes_by_receta,
                changes_preview: changes.slice(0, 20)
            });
        } catch (err) {
            log('error', 'Error recalculando COGS', { error: err.message, stack: err.stack });
            res.status(500).json({ error: 'Error recalculando', details: err.message });
        }
    });

    /**
     * GET /analytics/pnl-breakdown?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
     * Breaks down ingresos + cogs + food_cost_pct by category bucket:
     *   food / beverage / otros / total.
     */
    router.get('/analytics/pnl-breakdown', authMiddleware, async (req, res) => {
        try {
            let { desde, hasta } = req.query;
            if (!desde || !hasta) {
                const def = defaultMesActual();
                if (!desde) desde = def.desde;
                if (!hasta) hasta = def.hasta;
            }
            const { rows } = await pool.query(
                `SELECT
                    CASE
                        WHEN LOWER(COALESCE(r.categoria, '')) IN ('bebida', 'bebidas') THEN 'beverage'
                        WHEN LOWER(COALESCE(r.categoria, '')) IN ('suministro', 'suministros', 'preparacion base', 'preparaciones base') THEN 'otros'
                        ELSE 'food'
                    END AS bucket,
                    COALESCE(SUM(vdr.total_ingresos), 0)::numeric(14,2) AS ingresos,
                    COALESCE(SUM(vdr.coste_ingredientes), 0)::numeric(14,2) AS cogs,
                    COALESCE(SUM(vdr.beneficio_bruto), 0)::numeric(14,2) AS margen
                 FROM ventas_diarias_resumen vdr
                 LEFT JOIN recetas r ON r.id = vdr.receta_id
                 WHERE vdr.restaurante_id = $1 AND vdr.fecha >= $2 AND vdr.fecha < $3
                 GROUP BY bucket`,
                [req.restauranteId, desde, hasta]
            );
            const mkBucket = (name) => {
                const row = rows.find(r => r.bucket === name);
                const ingresos = row ? parseFloat(row.ingresos) || 0 : 0;
                const cogs = row ? parseFloat(row.cogs) || 0 : 0;
                const margen = row ? parseFloat(row.margen) || 0 : 0;
                const pct = ingresos > 0 ? (cogs / ingresos) * 100 : 0;
                return { ingresos, cogs, margen, food_cost_pct: Math.round(pct * 100) / 100 };
            };
            const food = mkBucket('food');
            const beverage = mkBucket('beverage');
            const otros = mkBucket('otros');
            const totalIngresos = food.ingresos + beverage.ingresos + otros.ingresos;
            const totalCogs = food.cogs + beverage.cogs + otros.cogs;
            const totalMargen = food.margen + beverage.margen + otros.margen;
            const totalPct = totalIngresos > 0 ? (totalCogs / totalIngresos) * 100 : 0;
            res.json({
                periodo: { desde, hasta },
                food, beverage, otros,
                total: {
                    ingresos: Math.round(totalIngresos * 100) / 100,
                    cogs: Math.round(totalCogs * 100) / 100,
                    margen: Math.round(totalMargen * 100) / 100,
                    food_cost_pct: Math.round(totalPct * 100) / 100
                }
            });
        } catch (err) {
            log('error', 'Error en /analytics/pnl-breakdown', { error: err.message });
            res.status(500).json({ error: 'Error calculando breakdown' });
        }
    });

    /**
     * GET /analytics/food-cost?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
     * Legacy endpoint — returns total food_cost_pct (mixes food + beverage).
     * Prefer /analytics/pnl-breakdown for separated buckets.
     */
    router.get('/analytics/food-cost', authMiddleware, async (req, res) => {
        try {
            let { desde, hasta } = req.query;
            if (!desde || !hasta) {
                const def = defaultMesActual();
                if (!desde) desde = def.desde;
                if (!hasta) hasta = def.hasta;
            }
            const { rows } = await pool.query(
                `SELECT
                     COALESCE(SUM(total_ingresos), 0)::numeric(14,2) AS ingresos,
                     COALESCE(SUM(coste_ingredientes), 0)::numeric(14,2) AS cogs,
                     COALESCE(SUM(beneficio_bruto), 0)::numeric(14,2) AS margen
                 FROM ventas_diarias_resumen
                 WHERE restaurante_id = $1 AND fecha >= $2 AND fecha < $3`,
                [req.restauranteId, desde, hasta]
            );
            const ingresos = parseFloat(rows[0].ingresos) || 0;
            const cogs = parseFloat(rows[0].cogs) || 0;
            const margen = parseFloat(rows[0].margen) || 0;
            const food_cost_pct = ingresos > 0 ? (cogs / ingresos) * 100 : 0;
            res.json({
                periodo: { desde, hasta },
                ingresos, cogs, margen,
                food_cost_pct: Math.round(food_cost_pct * 100) / 100
            });
        } catch (err) {
            log('error', 'Error en /analytics/food-cost', { error: err.message });
            res.status(500).json({ error: 'Error calculando food cost' });
        }
    });

    return router;
};
