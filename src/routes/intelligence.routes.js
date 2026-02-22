/**
 * intelligence Routes — Extracted from server.js
 * AI Intelligence: freshness, purchase planning, overstock detection, price review
 */
const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { requirePlan } = require('../middleware/planGate');
const { log } = require('../utils/logger');
const { buildIngredientPriceMap } = require('../utils/businessHelpers');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== 🧠 INTELIGENCIA - ENDPOINT FRESCURA ==========
    // Días de vida útil por familia (estándares conservadores para seguridad alimentaria)
    // NOTA: Valores conservadores asumiendo producto fresco/descongelado
    const VIDA_UTIL_DIAS = {
        'pescado': 3,    // Fresco o descongelado: usar rápido
        'marisco': 3,    // Fresco o descongelado: usar rápido  
        'carne': 4,
        'verdura': 5,
        'lacteo': 5,
        'bebida': 30,
        'alimento': 4,
        'default': 7
    };

    router.get('/intelligence/freshness', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            const result = await pool.query(`
            WITH compras_recientes AS (
                SELECT 
                    p.id as pedido_id,
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
                i.id,
                i.nombre,
                i.familia,
                i.stock_actual,
                i.unidad,
                c.dias_desde_compra,
                c.fecha_recepcion
            FROM compras_recientes c
            JOIN ingredientes i ON i.id = c.ingrediente_id::int
            WHERE i.stock_actual > 0 AND i.deleted_at IS NULL
            ORDER BY c.dias_desde_compra DESC
        `, [req.restauranteId]);

            // Solo productos frescos (carne, pescado, marisco)
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
            log('error', 'Error en intelligence/freshness', { error: err.message });
            res.status(500).json({ error: 'Error interno', alertas: [] });
        }
    });

    // ========== 🧠 INTELIGENCIA - PLAN COMPRAS ==========
    router.get('/intelligence/purchase-plan', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            const targetDay = parseInt(req.query.day) || 6; // Sábado por defecto
            const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

            const result = await pool.query(`
            WITH consumo_por_dia AS (
                SELECT 
                    EXTRACT(DOW FROM v.fecha) as dia_semana,
                    ri.ingrediente_id,
                    SUM(ri.cantidad * v.cantidad) as consumo_total,
                    COUNT(DISTINCT v.fecha) as dias_distintos
                FROM ventas v
                JOIN recetas r ON r.id = v.receta_id
                CROSS JOIN LATERAL jsonb_array_elements(r.ingredientes) AS ri_json
                CROSS JOIN LATERAL (
                    SELECT 
                        (ri_json->>'ingredienteId')::int as ingrediente_id,
                        (ri_json->>'cantidad')::numeric as cantidad
                ) ri
                WHERE v.restaurante_id = $1
                  AND v.fecha >= CURRENT_DATE - INTERVAL '8 weeks'
                  AND v.deleted_at IS NULL AND r.deleted_at IS NULL
                GROUP BY EXTRACT(DOW FROM v.fecha), ri.ingrediente_id
            )
            SELECT 
                i.id,
                i.nombre,
                i.familia,
                i.stock_actual,
                i.unidad,
                COALESCE(c.consumo_total / NULLIF(c.dias_distintos, 0), 0) as consumo_promedio,
                COALESCE(c.consumo_total / NULLIF(c.dias_distintos, 0), 0) * 1.2 as par_level,
                i.stock_actual - (COALESCE(c.consumo_total / NULLIF(c.dias_distintos, 0), 0) * 1.2) as diferencia
            FROM ingredientes i
            LEFT JOIN consumo_por_dia c ON c.ingrediente_id = i.id AND c.dia_semana = $2
            WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL
              AND c.consumo_total > 0
            ORDER BY diferencia ASC
        `, [req.restauranteId, targetDay]);

            const sugerencias = result.rows
                .filter(r => parseFloat(r.diferencia) < 0)
                .map(r => ({
                    ...r,
                    sugerencia_pedido: Math.abs(parseFloat(r.diferencia))
                }));

            res.json({
                dia_objetivo: DIAS[targetDay],
                sugerencias
            });
        } catch (err) {
            log('error', 'Error en intelligence/purchase-plan', { error: err.message });
            res.status(500).json({ error: 'Error interno', sugerencias: [] });
        }
    });

    // ========== 🧠 INTELIGENCIA - SOBRESTOCK ==========
    // Festivos Galicia 2026 - tratar como sábados
    const FESTIVOS_GALICIA = [
        '2026-01-01', '2026-01-06', '2026-04-09', '2026-04-10',
        '2026-05-01', '2026-05-17', '2026-07-25', '2026-08-15',
        '2026-10-12', '2026-11-01', '2026-12-06', '2026-12-08', '2026-12-25'
    ];

    router.get('/intelligence/overstock', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            // Calcular día efectivo (festivos = sábado)
            const hoy = new Date().toISOString().split('T')[0];
            const esFestivo = FESTIVOS_GALICIA.includes(hoy);
            const diaActual = esFestivo ? 6 : new Date().getDay();

            const result = await pool.query(`
            WITH consumo_por_dia AS (
                SELECT 
                    ri.ingrediente_id,
                    EXTRACT(DOW FROM v.fecha) as dia_semana,
                    SUM(ri.cantidad * v.cantidad) as consumo_total,
                    COUNT(DISTINCT v.fecha) as dias_contados
                FROM ventas v
                JOIN recetas r ON r.id = v.receta_id
                CROSS JOIN LATERAL jsonb_array_elements(r.ingredientes) AS ri_json
                CROSS JOIN LATERAL (
                    SELECT 
                        (ri_json->>'ingredienteId')::int as ingrediente_id,
                        (ri_json->>'cantidad')::numeric as cantidad
                ) ri
                WHERE v.restaurante_id = $1
                  AND v.fecha >= CURRENT_DATE - INTERVAL '8 weeks'
                  AND v.deleted_at IS NULL AND r.deleted_at IS NULL
                GROUP BY ri.ingrediente_id, EXTRACT(DOW FROM v.fecha)
            ),
            consumo_dia_actual AS (
                SELECT 
                    ingrediente_id,
                    consumo_total / NULLIF(dias_contados, 0) as consumo_dia
                FROM consumo_por_dia
                WHERE dia_semana = $2
            )
            SELECT 
                i.id, i.nombre, i.familia, i.stock_actual, i.unidad,
                COALESCE(c.consumo_dia, 0) as consumo_diario,
                CASE WHEN COALESCE(c.consumo_dia, 0) > 0 
                    THEN i.stock_actual / c.consumo_dia ELSE 999 END as dias_stock
            FROM ingredientes i
            LEFT JOIN consumo_dia_actual c ON c.ingrediente_id = i.id
            WHERE i.restaurante_id = $1 AND i.stock_actual > 0 AND i.deleted_at IS NULL
              AND COALESCE(c.consumo_dia, 0) > 0
            ORDER BY dias_stock DESC
        `, [req.restauranteId, diaActual]);

            const FAMILIAS_FRESCAS = ['carne', 'pescado', 'marisco'];
            const UMBRAL_DIAS = { 'marisco': 3, 'pescado': 3, 'carne': 5, 'default': 7 };

            const sobrestock = result.rows
                .filter(r => FAMILIAS_FRESCAS.includes(r.familia?.toLowerCase()))
                .filter(r => {
                    const umbral = UMBRAL_DIAS[r.familia?.toLowerCase()] || UMBRAL_DIAS['default'];
                    return parseFloat(r.dias_stock) > umbral;
                });

            res.json(sobrestock);
        } catch (err) {
            log('error', 'Error en intelligence/overstock', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== 🧠 INTELIGENCIA - REVISION PRECIOS ==========
    router.get('/intelligence/price-check', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            const TARGET_FOOD_COST = 35;
            const ALERT_THRESHOLD = 40;

            const result = await pool.query(`
            SELECT 
                r.id,
                r.nombre,
                r.precio_venta,
                r.ingredientes
            FROM recetas r
            WHERE r.restaurante_id = $1
              AND r.precio_venta > 0
              AND r.deleted_at IS NULL
        `, [req.restauranteId]);

            const ingredientes = await pool.query(`
            SELECT id, nombre, precio, cantidad_por_formato
            FROM ingredientes 
            WHERE restaurante_id = $1 AND deleted_at IS NULL
        `, [req.restauranteId]);

            const ingMap = buildIngredientPriceMap(ingredientes.rows);

            const recetasProblema = result.rows
                .map(r => {
                    let coste = 0;
                    if (r.ingredientes && Array.isArray(r.ingredientes)) {
                        r.ingredientes.forEach(ing => {
                            const precioIng = ingMap[ing.ingredienteId] || 0;
                            coste += precioIng * (ing.cantidad || 0);
                        });
                    }
                    const precioVenta = parseFloat(r.precio_venta) || 0;
                    const foodCost = precioVenta > 0 ? (coste / precioVenta) * 100 : 0;
                    const precioSugerido = coste / (TARGET_FOOD_COST / 100);

                    return {
                        id: r.id,
                        nombre: r.nombre,
                        coste,
                        precio_actual: precioVenta,
                        food_cost: Math.round(foodCost),
                        precio_sugerido: precioSugerido
                    };
                })
                .filter(r => r.food_cost > ALERT_THRESHOLD);

            res.json({
                objetivo: TARGET_FOOD_COST,
                umbral_alerta: ALERT_THRESHOLD,
                recetas_problema: recetasProblema
            });
        } catch (err) {
            log('error', 'Error en intelligence/price-check', { error: err.message });
            res.status(500).json({ error: 'Error interno', recetas_problema: [] });
        }
    });


    return router;
};
