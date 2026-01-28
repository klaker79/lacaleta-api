/**
 * ============================================
 * routes/intelligence.routes.js - Rutas de IA
 * ============================================
 *
 * Endpoints de inteligencia: freshness, purchase-plan, overstock, price-check
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const express = require('express');
const router = express.Router();

const { pool } = require('../config/database');
const { log } = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth');

// Vida útil por familia (días)
const VIDA_UTIL_DIAS = {
    'marisco': 2, 'pescado': 2, 'carne': 4, 'verdura': 5,
    'fruta': 4, 'lacteo': 7, 'default': 7
};

// Festivos Galicia 2026 (tratar como sábados)
const FESTIVOS_GALICIA = [
    '2026-01-01', '2026-01-06', '2026-04-09', '2026-04-10',
    '2026-05-01', '2026-05-17', '2026-07-25', '2026-08-15',
    '2026-10-12', '2026-11-01', '2026-12-06', '2026-12-08', '2026-12-25'
];

/**
 * GET /api/intelligence/freshness
 * Alertas de frescura de productos perecederos
 */
router.get('/freshness', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            WITH compras_recientes AS (
                SELECT 
                    p.fecha_recepcion,
                    CURRENT_DATE - p.fecha_recepcion::date as dias_desde_compra,
                    ing->>'ingredienteId' as ingrediente_id,
                    (ing->>'cantidad')::numeric as cantidad_comprada
                FROM pedidos p
                CROSS JOIN LATERAL jsonb_array_elements(p.ingredientes) AS ing
                WHERE p.restaurante_id = $1
                  AND p.estado = 'recibido'
                  AND p.fecha_recepcion IS NOT NULL
                  AND p.fecha_recepcion >= CURRENT_DATE - INTERVAL '7 days'
            )
            SELECT 
                i.id, i.nombre, i.familia, i.stock_actual, i.unidad,
                c.dias_desde_compra, c.fecha_recepcion
            FROM compras_recientes c
            JOIN ingredientes i ON i.id = c.ingrediente_id::int
            WHERE i.stock_actual > 0
            ORDER BY c.dias_desde_compra DESC
        `, [req.restauranteId]);

        const FAMILIAS_FRESCAS = ['carne', 'pescado', 'marisco'];

        const alertas = result.rows
            .filter(row => FAMILIAS_FRESCAS.includes((row.familia || '').toLowerCase()))
            .map(row => {
                const familia = (row.familia || 'default').toLowerCase();
                const vidaUtil = VIDA_UTIL_DIAS[familia] || VIDA_UTIL_DIAS['default'];
                const diasRestantes = vidaUtil - (row.dias_desde_compra || 0);

                return {
                    ...row,
                    vida_util: vidaUtil,
                    dias_restantes: diasRestantes,
                    urgencia: diasRestantes <= 0 ? 'critico' : diasRestantes === 1 ? 'hoy' : diasRestantes <= 2 ? 'mañana' : 'ok'
                };
            })
            .filter(a => a.dias_restantes <= 2);

        res.json(alertas);
    } catch (err) {
        log('error', 'Error en freshness', { error: err.message });
        res.status(500).json({ error: 'Error interno', alertas: [] });
    }
});

/**
 * GET /api/intelligence/purchase-plan
 * Plan de compras basado en consumo histórico
 */
router.get('/purchase-plan', authMiddleware, async (req, res) => {
    try {
        const targetDay = parseInt(req.query.day) || 6;
        const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

        const result = await pool.query(`
            WITH consumo_por_dia AS (
                SELECT 
                    EXTRACT(DOW FROM v.fecha) as dia_semana,
                    (ri_json->>'ingredienteId')::int as ingrediente_id,
                    SUM((ri_json->>'cantidad')::numeric * v.cantidad) as consumo_total,
                    COUNT(DISTINCT v.fecha) as dias_distintos
                FROM ventas v
                JOIN recetas r ON r.id = v.receta_id
                CROSS JOIN LATERAL jsonb_array_elements(r.ingredientes) AS ri_json
                WHERE v.restaurante_id = $1
                  AND v.fecha >= CURRENT_DATE - INTERVAL '8 weeks'
                GROUP BY EXTRACT(DOW FROM v.fecha), (ri_json->>'ingredienteId')::int
            )
            SELECT 
                i.id, i.nombre, i.familia, i.stock_actual, i.unidad,
                COALESCE(c.consumo_total / NULLIF(c.dias_distintos, 0), 0) as consumo_promedio,
                COALESCE(c.consumo_total / NULLIF(c.dias_distintos, 0), 0) * 1.2 as par_level,
                i.stock_actual - (COALESCE(c.consumo_total / NULLIF(c.dias_distintos, 0), 0) * 1.2) as diferencia
            FROM ingredientes i
            LEFT JOIN consumo_por_dia c ON c.ingrediente_id = i.id AND c.dia_semana = $2
            WHERE i.restaurante_id = $1 AND c.consumo_total > 0
            ORDER BY diferencia ASC
        `, [req.restauranteId, targetDay]);

        const sugerencias = result.rows
            .filter(r => parseFloat(r.diferencia) < 0)
            .map(r => ({ ...r, sugerencia_pedido: Math.abs(parseFloat(r.diferencia)) }));

        res.json({ dia_objetivo: DIAS[targetDay], sugerencias });
    } catch (err) {
        log('error', 'Error en purchase-plan', { error: err.message });
        res.status(500).json({ error: 'Error interno', sugerencias: [] });
    }
});

/**
 * GET /api/intelligence/overstock
 * Detección de sobrestock de productos frescos
 */
router.get('/overstock', authMiddleware, async (req, res) => {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        const esFestivo = FESTIVOS_GALICIA.includes(hoy);
        const diaActual = esFestivo ? 6 : new Date().getDay();

        const result = await pool.query(`
            WITH consumo_por_dia AS (
                SELECT 
                    (ri_json->>'ingredienteId')::int as ingrediente_id,
                    EXTRACT(DOW FROM v.fecha) as dia_semana,
                    SUM((ri_json->>'cantidad')::numeric * v.cantidad) as consumo_total,
                    COUNT(DISTINCT v.fecha) as dias_contados
                FROM ventas v
                JOIN recetas r ON r.id = v.receta_id
                CROSS JOIN LATERAL jsonb_array_elements(r.ingredientes) AS ri_json
                WHERE v.restaurante_id = $1 AND v.fecha >= CURRENT_DATE - INTERVAL '8 weeks'
                GROUP BY (ri_json->>'ingredienteId')::int, EXTRACT(DOW FROM v.fecha)
            ),
            consumo_dia_actual AS (
                SELECT ingrediente_id, consumo_total / NULLIF(dias_contados, 0) as consumo_dia
                FROM consumo_por_dia WHERE dia_semana = $2
            )
            SELECT 
                i.id, i.nombre, i.familia, i.stock_actual, i.unidad,
                COALESCE(c.consumo_dia, 0) as consumo_diario,
                CASE WHEN COALESCE(c.consumo_dia, 0) > 0 THEN i.stock_actual / c.consumo_dia ELSE 999 END as dias_stock
            FROM ingredientes i
            LEFT JOIN consumo_dia_actual c ON c.ingrediente_id = i.id
            WHERE i.restaurante_id = $1 AND i.stock_actual > 0 AND COALESCE(c.consumo_dia, 0) > 0
            ORDER BY dias_stock DESC
        `, [req.restauranteId, diaActual]);

        const FAMILIAS_FRESCAS = ['carne', 'pescado', 'marisco'];
        const UMBRAL_DIAS = { 'marisco': 3, 'pescado': 3, 'carne': 5, 'default': 7 };

        const sobrestock = result.rows
            .filter(r => FAMILIAS_FRESCAS.includes(r.familia?.toLowerCase()))
            .filter(r => parseFloat(r.dias_stock) > (UMBRAL_DIAS[r.familia?.toLowerCase()] || 7));

        res.json(sobrestock);
    } catch (err) {
        log('error', 'Error en overstock', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * GET /api/intelligence/price-check
 * Revisión de precios basado en food cost
 */
router.get('/price-check', authMiddleware, async (req, res) => {
    try {
        const TARGET_FOOD_COST = 35;
        const ALERT_THRESHOLD = 40;

        const recetas = await pool.query(
            'SELECT id, nombre, precio_venta, ingredientes FROM recetas WHERE restaurante_id = $1 AND precio_venta > 0',
            [req.restauranteId]
        );

        const ingredientes = await pool.query(
            'SELECT id, precio, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1',
            [req.restauranteId]
        );

        const ingMap = {};
        ingredientes.rows.forEach(i => {
            ingMap[i.id] = i.cantidad_por_formato > 0
                ? parseFloat(i.precio) / i.cantidad_por_formato
                : parseFloat(i.precio);
        });

        const recetasProblema = recetas.rows
            .map(r => {
                let coste = 0;
                (r.ingredientes || []).forEach(ing => {
                    coste += (ingMap[ing.ingredienteId] || 0) * (ing.cantidad || 0);
                });
                const precioVenta = parseFloat(r.precio_venta) || 0;
                const foodCost = precioVenta > 0 ? (coste / precioVenta) * 100 : 0;

                return {
                    id: r.id, nombre: r.nombre, coste, precio_actual: precioVenta,
                    food_cost: Math.round(foodCost),
                    precio_sugerido: coste / (TARGET_FOOD_COST / 100)
                };
            })
            .filter(r => r.food_cost > ALERT_THRESHOLD);

        res.json({ objetivo: TARGET_FOOD_COST, umbral_alerta: ALERT_THRESHOLD, recetas_problema: recetasProblema });
    } catch (err) {
        log('error', 'Error en price-check', { error: err.message });
        res.status(500).json({ error: 'Error interno', recetas_problema: [] });
    }
});

module.exports = router;
