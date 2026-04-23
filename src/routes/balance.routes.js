/**
 * balance Routes — Extracted from server.js
 * Balance, statistics, daily cost/sales tracking
 */
const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { requirePlan } = require('../middleware/planGate');
const { log } = require('../utils/logger');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();


    // ========== BALANCE Y ESTADÍSTICAS ==========
    // NOTE: los endpoints /analytics/* (food-cost, pnl-breakdown, recalculate-cogs)
    // se movieron a routes/analytics.routes.js el 2026-04-20.
    router.get('/balance/mes', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            const { mes, ano } = req.query;
            const mesActual = parseInt(mes) || new Date().getMonth() + 1;
            const anoActual = parseInt(ano) || new Date().getFullYear();

            // Use date range instead of EXTRACT for index usage
            const startDate = `${anoActual}-${String(mesActual).padStart(2, '0')}-01`;
            const nextMonth = mesActual === 12 ? 1 : mesActual + 1;
            const nextYear = mesActual === 12 ? anoActual + 1 : anoActual;
            const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

            const ventasMes = await pool.query(
                `SELECT COALESCE(SUM(total), 0) as ingresos, COUNT(*) as num_ventas
       FROM ventas
       WHERE fecha >= $1 AND fecha < $2 AND restaurante_id = $3 AND deleted_at IS NULL`,
                [startDate, endDate, req.restauranteId]
            );

            const ventasDetalle = await pool.query(
                `SELECT v.cantidad, r.ingredientes, r.porciones
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE v.fecha >= $1 AND v.fecha < $2 AND v.restaurante_id = $3 AND v.deleted_at IS NULL AND r.deleted_at IS NULL`,
                [startDate, endDate, req.restauranteId]
            );

            // Precargar precios de ingredientes + media de compras reales
            const ingredientesResult = await pool.query(
                `SELECT i.id, i.precio, i.cantidad_por_formato, i.rendimiento,
                        pcd.precio_medio_compra
                 FROM ingredientes i
                 LEFT JOIN (
                     SELECT ingrediente_id, ROUND(AVG(precio_unitario)::numeric, 4) as precio_medio_compra
                     FROM precios_compra_diarios WHERE restaurante_id = $1
                     GROUP BY ingrediente_id
                 ) pcd ON pcd.ingrediente_id = i.id
                 WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL`,
                [req.restauranteId]
            );
            const preciosMap = new Map();
            const rendimientoBaseMap = new Map();
            ingredientesResult.rows.forEach(i => {
                if (i.precio_medio_compra) {
                    preciosMap.set(i.id, parseFloat(i.precio_medio_compra));
                } else {
                    const precio = parseFloat(i.precio) || 0;
                    const cpf = parseFloat(i.cantidad_por_formato) || 1;
                    preciosMap.set(i.id, precio / cpf);
                }
                if (i.rendimiento) {
                    rendimientoBaseMap.set(i.id, parseFloat(i.rendimiento));
                }
            });

            // Calcular costos usando el Map (sin queries adicionales)
            let costos = 0;
            for (const venta of ventasDetalle.rows) {
                const ingredientes = venta.ingredientes || [];
                const porciones = Math.max(1, parseInt(venta.porciones) || 1);
                for (const ing of ingredientes) {
                    const precio = preciosMap.get(ing.ingredienteId) || 0;
                    // 🔧 FIX: Rendimiento con fallback al ingrediente base
                    let rendimiento = parseFloat(ing.rendimiento);
                    if (!rendimiento) {
                        rendimiento = rendimientoBaseMap.get(ing.ingredienteId) || 100;
                    }
                    const factorRendimiento = rendimiento / 100;
                    const costeReal = factorRendimiento > 0 ? (precio / factorRendimiento) : precio;
                    costos += (costeReal * (ing.cantidad || 0) * venta.cantidad) / porciones;
                }
            }

            const ingresos = parseFloat(ventasMes.rows[0].ingresos) || 0;
            const ganancia = ingresos - costos;
            const margen = ingresos > 0 ? ((ganancia / ingresos) * 100).toFixed(1) : 0;

            const platoMasVendido = await pool.query(
                `SELECT r.nombre, SUM(v.cantidad) as total_vendido
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE v.fecha >= $1 AND v.fecha < $2 AND v.restaurante_id = $3 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
       GROUP BY r.nombre
       ORDER BY total_vendido DESC
       LIMIT 1`,
                [startDate, endDate, req.restauranteId]
            );

            const ventasPorPlato = await pool.query(
                `SELECT r.nombre, SUM(v.total) as total_ingresos, SUM(v.cantidad) as cantidad
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE v.fecha >= $1 AND v.fecha < $2 AND v.restaurante_id = $3 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
       GROUP BY r.nombre
       ORDER BY total_ingresos DESC`,
                [startDate, endDate, req.restauranteId]
            );

            const valorInventario = await pool.query(
                `SELECT COALESCE(SUM(i.stock_actual * COALESCE(pcd.precio_medio_compra, i.precio / COALESCE(NULLIF(i.cantidad_por_formato, 0), 1))), 0) as valor
       FROM ingredientes i
       LEFT JOIN (
           SELECT ingrediente_id, ROUND(AVG(precio_unitario)::numeric, 4) as precio_medio_compra
           FROM precios_compra_diarios WHERE restaurante_id = $1
           GROUP BY ingrediente_id
       ) pcd ON pcd.ingrediente_id = i.id
       WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL`,
                [req.restauranteId]
            );

            res.json({
                ingresos,
                costos,
                ganancia,
                margen: parseFloat(margen),
                num_ventas: parseInt(ventasMes.rows[0].num_ventas) || 0,
                plato_mas_vendido: platoMasVendido.rows[0] || null,
                ventas_por_plato: ventasPorPlato.rows || [],
                valor_inventario: parseFloat(valorInventario.rows[0].valor) || 0
            });
        } catch (error) {
            log('error', 'Error obteniendo balance', { error: error.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.get('/balance/comparativa', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            const meses = await pool.query(
                `SELECT 
         TO_CHAR(fecha, 'YYYY-MM') as mes,
         SUM(total) as ingresos,
         COUNT(*) as num_ventas
       FROM ventas
       WHERE restaurante_id = $1 AND deleted_at IS NULL
       GROUP BY TO_CHAR(fecha, 'YYYY-MM')
       ORDER BY mes DESC
       LIMIT 12`,
                [req.restauranteId]
            );
            res.json(meses.rows || []);
        } catch (error) {
            log('error', 'Error comparativa', { error: error.message });
            res.status(500).json({ error: 'Error interno', data: [] });
        }
    });

    // ========== TRACKING DIARIO DE COSTES/VENTAS ==========

    // Obtener precios de compra diarios


    // Obtener resumen diario de ventas



    return router;
};
