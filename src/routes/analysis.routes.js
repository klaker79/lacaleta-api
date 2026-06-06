/**
 * analysis Routes — Extracted from server.js
 * Menu engineering analysis (BCG matrix)
 */
const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { getBackendIngredientUnitPrice, getRecipeCostBase } = require('../utils/businessHelpers');
const { nonFoodCategoriesSqlList } = require('../utils/categoriaClassifier');
const { validateDate } = require('../utils/validators');
const {
    calcularDispersion,
    calcularAmplitud,
    calcularCalidadPrecio,
    generarRecomendacionGlobal
} = require('../utils/omnesCalculator');

/**
 * Resuelve el rango de fechas para queries de análisis.
 * Si llegan `desde`/`hasta` válidos, los usa. Si no, devuelve `null`
 * para que la query no aplique filtro temporal (comportamiento histórico
 * = compatibilidad backward con clientes que no envían filtro).
 *
 * @param {string|undefined} desde - YYYY-MM-DD
 * @param {string|undefined} hasta - YYYY-MM-DD (exclusivo)
 * @returns {{ desde: string, hasta: string } | null}
 */
function resolverPeriodo(desde, hasta) {
    if (!desde && !hasta) return null;
    const d = validateDate(desde);
    const h = validateDate(hasta);
    if (!d.valid || !h.valid) return null;
    return {
        desde: desde,
        hasta: hasta
    };
}

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== ANÁLISIS AVANZADO ==========
    router.get('/analysis/menu-engineering', authMiddleware, async (req, res) => {
        try {
            // 🏷️ Capa 5 auditoría 2026-04-28: lista canónica vía categoriaClassifier.
            // Antes la lista NOT IN estaba hardcoded y divergía del bucketing
            // food/beverage de chatService y dashboard. Ahora una única fuente:
            // bebidas (BEVERAGE_CATEGORIES) + suministros/preparaciones base
            // (OTHER_CATEGORIES) — idéntico a lo que pnl-breakdown excluye del
            // food cost. Las recetas FOOD son el complemento exacto.
            const nonFoodList = nonFoodCategoriesSqlList();
            // Parámetros opcionales de periodo (rediseño 2026-06-05).
            // Si llegan ambos, las ventas se filtran al rango [desde, hasta).
            // Si NO llegan, mantenemos el comportamiento histórico (todas las
            // ventas) para backward-compat con clientes que aún no envían filtro.
            const periodo = resolverPeriodo(req.query.desde, req.query.hasta);
            const ventasFiltroFecha = periodo
                ? `AND v.fecha >= $2 AND v.fecha < $3`
                : '';
            const ventasParams = periodo
                ? [req.restauranteId, periodo.desde, periodo.hasta]
                : [req.restauranteId];
            // Query 1: TODAS las recetas activas FOOD del tenant + ventas si las hay.
            // LEFT JOIN para que las recetas activas sin ventas también entren al
            // análisis. Sin esto (INNER JOIN previo), un plato que está en la carta
            // pero no se vende quedaba invisible — justamente lo que un Perro debe
            // gritar en la matriz BCG. Reportado por Iker 2026-05-07: borró ventas
            // de SOLOMILLO, no era rentable, esperaba verlo en Perros y no aparecía.
            const ventas = await pool.query(
                `SELECT r.id, r.nombre, r.categoria, r.precio_venta, r.ingredientes, r.porciones,
                    COALESCE(SUM(v.cantidad), 0) as cantidad_vendida,
                    COALESCE(SUM(v.total), 0) as total_ventas
             FROM recetas r
             LEFT JOIN ventas v
                ON v.receta_id = r.id
               AND v.restaurante_id = $1
               AND v.deleted_at IS NULL
               ${ventasFiltroFecha}
             WHERE r.restaurante_id = $1
               AND r.deleted_at IS NULL
               AND r.activo = TRUE
               AND LOWER(TRIM(COALESCE(r.categoria, ''))) NOT IN (${nonFoodList})
             GROUP BY r.id, r.nombre, r.categoria, r.precio_venta, r.ingredientes, r.porciones`,
                ventasParams
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
            // Las medias de popularidad y margen se calculan SOLO sobre recetas
            // con ventas reales. Si incluyéramos las recetas sin ventas en el
            // divisor, la media de popularidad bajaría artificialmente y casi
            // todo plato vendido aparecería como "popular", desvirtuando la
            // matriz BCG. Las recetas sin ventas se incluyen al final del
            // resultado (popularidad=0 → siempre debajo de la media → Perro o
            // Puzzle según margen).
            const ventasConDatos = ventas.rows.filter(v => parseFloat(v.cantidad_vendida) > 0);
            const totalVentasRestaurante = ventasConDatos.reduce((sum, v) => sum + parseFloat(v.cantidad_vendida), 0);
            const promedioPopularidad = ventasConDatos.length > 0 ? totalVentasRestaurante / ventasConDatos.length : 0;
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
            // Food cost medio: solo sobre platos con ventas reales — coherente con
            // popularidad y margen. Las recetas sin ventas no representan el
            // comportamiento real del menú aunque tengan un food cost calculable.
            const platosConVentas = analisis.filter(p => p.popularidad > 0);
            const promedioFoodCost = platosConVentas.length > 0
                ? platosConVentas.reduce((sum, p) => sum + p.foodCost, 0) / platosConVentas.length
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


    /**
     * GET /analysis/omnes?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
     *
     * Principios de Omnes — análisis avanzado de la estrategia de carta.
     * Tres sub-análisis:
     *   1. Dispersión: ratio precio_max / precio_min de la carta food. Ideal ≤ 2.5.
     *   2. Amplitud de gama: distribución % en baja/media/alta. Ideal 25/50/25.
     *   3. Relación calidad-precio: precio_medio_vendido / precio_medio_ofertado. Ideal 0.95-1.05.
     *
     * Excluye bebidas y categorías base (vía nonFoodCategoriesSqlList) idéntico a /menu-engineering.
     * Multi-tenant: WHERE r.restaurante_id en todas las queries.
     * Soft-delete: AND r.deleted_at IS NULL / v.deleted_at IS NULL.
     * Si llegan periodos válidos, filtra ventas al rango [desde, hasta).
     * Si NO llegan o son inválidos, usa el histórico completo (compat back).
     */
    router.get('/analysis/omnes', authMiddleware, async (req, res) => {
        try {
            const periodo = resolverPeriodo(req.query.desde, req.query.hasta);
            const nonFoodList = nonFoodCategoriesSqlList();

            const ventasFiltroFecha = periodo
                ? `AND v.fecha >= $2 AND v.fecha < $3`
                : '';
            const ventasParams = periodo
                ? [req.restauranteId, periodo.desde, periodo.hasta]
                : [req.restauranteId];

            // Query única que junta precio_venta de TODOS los platos food activos
            // (para dispersión + amplitud) y agrega ventas en el periodo (para
            // calidad-precio). Misma exclusión non-food que /menu-engineering.
            const { rows } = await pool.query(
                `SELECT r.id, r.nombre, r.precio_venta,
                        COALESCE(SUM(v.cantidad), 0) AS cantidad_vendida
                 FROM recetas r
                 LEFT JOIN ventas v
                    ON v.receta_id = r.id
                   AND v.restaurante_id = $1
                   AND v.deleted_at IS NULL
                   ${ventasFiltroFecha}
                 WHERE r.restaurante_id = $1
                   AND r.deleted_at IS NULL
                   AND r.activo = TRUE
                   AND LOWER(TRIM(COALESCE(r.categoria, ''))) NOT IN (${nonFoodList})
                   AND r.precio_venta IS NOT NULL
                   AND r.precio_venta > 0
                 GROUP BY r.id, r.nombre, r.precio_venta`,
                ventasParams
            );

            const platos = rows.map(r => ({
                id: r.id,
                nombre: r.nombre,
                precio_venta: parseFloat(r.precio_venta),
                cantidad_vendida: parseFloat(r.cantidad_vendida) || 0
            }));

            const dispersion = calcularDispersion(platos);
            const amplitud = calcularAmplitud(platos);
            const calidadPrecio = calcularCalidadPrecio(platos);
            const recomendacion = generarRecomendacionGlobal({
                dispersion, amplitud, calidad_precio: calidadPrecio
            });

            res.json({
                periodo: periodo || { desde: null, hasta: null },
                dispersion,
                amplitud,
                calidad_precio: calidadPrecio,
                recomendacion_global: recomendacion
            });
        } catch (err) {
            log('error', 'Error /analysis/omnes', { error: err.message });
            res.status(500).json({ error: 'Error calculando Principios de Omnes' });
        }
    });


    return router;
};
