/**
 * analysis Routes — Extracted from server.js
 * Menu engineering analysis (BCG matrix)
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

    // ========== ANÁLISIS AVANZADO ==========
    router.get('/analysis/menu-engineering', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            // Query 1: Ventas agrupadas por receta
            const ventas = await pool.query(
                `SELECT r.id, r.nombre, r.categoria, r.precio_venta, r.ingredientes, r.porciones,
                    SUM(v.cantidad) as cantidad_vendida,
                    SUM(v.total) as total_ventas
             FROM ventas v
             JOIN recetas r ON v.receta_id = r.id
             WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
               AND LOWER(COALESCE(r.categoria, '')) NOT IN ('bebidas', 'bebida', 'suministros', 'suministro', 'preparaciones base', 'preparacion base')
             GROUP BY r.id, r.nombre, r.categoria, r.precio_venta, r.ingredientes, r.porciones`,
                [req.restauranteId]
            );

            if (ventas.rows.length === 0) {
                return res.json([]);
            }

            // Query 2: Precios de ingredientes + media de compras reales
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
            ingredientesResult.rows.forEach(ing => {
                // Prioridad: media compras reales > precio config / cpf
                if (ing.precio_medio_compra) {
                    preciosMap.set(ing.id, parseFloat(ing.precio_medio_compra));
                } else {
                    const precioFormato = parseFloat(ing.precio) || 0;
                    const cantidadPorFormato = parseFloat(ing.cantidad_por_formato) || 1;
                    preciosMap.set(ing.id, precioFormato / cantidadPorFormato);
                }
                if (ing.rendimiento) {
                    rendimientoBaseMap.set(ing.id, parseFloat(ing.rendimiento));
                }
            });

            const analisis = [];
            const totalVentasRestaurante = ventas.rows.reduce((sum, v) => sum + parseFloat(v.cantidad_vendida), 0);
            const promedioPopularidad = ventas.rows.length > 0 ? totalVentasRestaurante / ventas.rows.length : 0;
            let sumaMargenes = 0;

            // Calcular costes usando el Map (sin queries adicionales)
            for (const plato of ventas.rows) {
                const ingredientes = plato.ingredientes || [];
                let costePlato = 0;

                if (ingredientes && Array.isArray(ingredientes)) {
                    for (const ing of ingredientes) {
                        const precioIng = preciosMap.get(ing.ingredienteId) || 0;
                        // 🔧 FIX: Rendimiento con fallback al ingrediente base
                        let rendimiento = parseFloat(ing.rendimiento);
                        if (!rendimiento || rendimiento === 100) {
                            rendimiento = rendimientoBaseMap.get(ing.ingredienteId) || 100;
                        }
                        const factorRendimiento = rendimiento / 100;
                        const costeReal = factorRendimiento > 0 ? (precioIng / factorRendimiento) : precioIng;
                        costePlato += costeReal * (ing.cantidad || 0);
                    }
                }

                // 🔧 FIX: Dividir por porciones para obtener coste POR PORCIÓN
                const porciones = parseInt(plato.porciones) || 1;
                costePlato = costePlato / porciones;

                const margenContribucion = parseFloat(plato.precio_venta) - costePlato;
                sumaMargenes += margenContribucion * parseFloat(plato.cantidad_vendida);

                analisis.push({
                    id: plato.id,
                    nombre: plato.nombre,
                    categoria: plato.categoria,
                    precio_venta: plato.precio_venta,
                    cantidad_vendida: plato.cantidad_vendida,
                    total_ventas: plato.total_ventas,
                    coste: costePlato,
                    margen: margenContribucion,
                    foodCost: parseFloat(plato.precio_venta) > 0
                        ? (costePlato / parseFloat(plato.precio_venta)) * 100
                        : 0,
                    popularidad: parseFloat(plato.cantidad_vendida)
                });
            }

            const promedioMargen = totalVentasRestaurante > 0 ? sumaMargenes / totalVentasRestaurante : 0;
            const promedioFoodCost = analisis.length > 0
                ? analisis.reduce((sum, p) => sum + p.foodCost, 0) / analisis.length
                : 0;

            const resultado = analisis.map(p => {
                const esPopular = p.popularidad >= (promedioPopularidad * 0.7);
                const esRentable = p.margen >= promedioMargen;
                const foodCostAlto = p.foodCost > 33; // Umbral industria

                let clasificacion = 'perro';
                if (esPopular && esRentable) clasificacion = 'estrella';
                else if (esPopular && !esRentable) clasificacion = 'caballo';
                else if (!esPopular && esRentable) clasificacion = 'puzzle';

                return {
                    ...p,
                    clasificacion,
                    metricas: {
                        esPopular,
                        esRentable,
                        foodCostAlto,
                        promedioPopularidad,
                        promedioMargen,
                        promedioFoodCost
                    }
                };
            });

            res.json(resultado);
        } catch (err) {
            log('error', 'Error análisis menú', { error: err.message });
            res.status(500).json({ error: 'Error analizando menú', data: [] });
        }
    });


    return router;
};
