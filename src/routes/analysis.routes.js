/**
 * analysis Routes — Extracted from server.js
 * Menu engineering analysis (BCG matrix)
 */
const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { requirePlan } = require('../middleware/planGate');
const { log } = require('../utils/logger');
const { getBackendIngredientUnitPrice, getRecipeCostBase } = require('../utils/businessHelpers');
const { nonFoodCategoriesSqlList } = require('../utils/categoriaClassifier');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== ANÁLISIS AVANZADO ==========
    router.get('/analysis/menu-engineering', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            // 🏷️ Capa 5 auditoría 2026-04-28: lista canónica vía categoriaClassifier.
            // Antes la lista NOT IN estaba hardcoded y divergía del bucketing
            // food/beverage de chatService y dashboard. Ahora una única fuente:
            // bebidas (BEVERAGE_CATEGORIES) + suministros/preparaciones base
            // (OTHER_CATEGORIES) — idéntico a lo que pnl-breakdown excluye del
            // food cost. Las recetas FOOD son el complemento exacto.
            const nonFoodList = nonFoodCategoriesSqlList();
            // Query 1: Ventas agrupadas por receta
            const ventas = await pool.query(
                `SELECT r.id, r.nombre, r.categoria, r.precio_venta, r.ingredientes, r.porciones,
                    SUM(v.cantidad) as cantidad_vendida,
                    SUM(v.total) as total_ventas
             FROM ventas v
             JOIN recetas r ON v.receta_id = r.id
             WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
               AND LOWER(COALESCE(r.categoria, '')) NOT IN (${nonFoodList})
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
                     SELECT ingrediente_id,
                            ROUND((SUM(total_compra) / NULLIF(SUM(cantidad_comprada), 0))::numeric, 4) as precio_medio_compra
                     FROM precios_compra_diarios WHERE restaurante_id = $1
                     GROUP BY ingrediente_id
                 ) pcd ON pcd.ingrediente_id = i.id
                 WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL`,
                [req.restauranteId]
            );
            const preciosMap = new Map();
            const rendimientoBaseMap = new Map();
            ingredientesResult.rows.forEach(ing => {
                preciosMap.set(ing.id, getBackendIngredientUnitPrice(ing));
                if (ing.rendimiento) {
                    rendimientoBaseMap.set(ing.id, parseFloat(ing.rendimiento));
                }
            });

            // Mapa de recetas (necesario para expandir subrecetas en getRecipeCostBase).
            // Cargamos todas las recetas del tenant; el filtro WHERE de menu engineering ya
            // excluye categorías "preparacion base" del result set principal, pero las
            // subrecetas SÍ pueden estar referenciadas como ingrediente desde recetas de food.
            const todasRecetasResult = await pool.query(
                'SELECT id, porciones, ingredientes FROM recetas WHERE restaurante_id = $1 AND deleted_at IS NULL',
                [req.restauranteId]
            );
            const recetasMap = new Map(todasRecetasResult.rows.map(r => [r.id, r]));

            const analisis = [];
            const totalVentasRestaurante = ventas.rows.reduce((sum, v) => sum + parseFloat(v.cantidad_vendida), 0);
            const promedioPopularidad = ventas.rows.length > 0 ? totalVentasRestaurante / ventas.rows.length : 0;
            let sumaMargenes = 0;

            // Calcular costes usando el helper canónico (Capa 3 auditoría: ahora expande subrecetas).
            for (const plato of ventas.rows) {
                const porciones = parseInt(plato.porciones) || 1;
                const costeLote = getRecipeCostBase(plato, preciosMap, recetasMap, rendimientoBaseMap);
                const costePlato = costeLote / porciones;

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
                const foodCostAlto = p.foodCost > 40; // >40% = alerta (umbral unificado 35/40)

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
