/**
 * menuEngineeringService.js — fuente única de verdad para Ingeniería de Menú y Omnes.
 *
 * Tanto los endpoints REST (`/analysis/menu-engineering`, `/analysis/omnes`)
 * como las tools del chat IA (`analisis_menu_engineering`, `analisis_omnes`)
 * deben llamar a este módulo. Así garantizamos que el chat ve EXACTAMENTE
 * los mismos números que la UI — sin reinventar fórmulas, sin riesgo de
 * divergencia.
 *
 * Multi-tenancy y soft-delete embebidos: `restauranteId` SIEMPRE en `WHERE`,
 * `deleted_at IS NULL` en recetas y ventas.
 *
 * Periodo opcional `{ desde, hasta }` (ISO YYYY-MM-DD, hasta exclusivo).
 * Si no se pasa, se usa el histórico completo (compat back).
 */

const { getBackendIngredientUnitPrice, getRecipeCostBase } = require('../utils/businessHelpers');
const { omnesExcludedCategoriesSqlList } = require('../utils/categoriaClassifier');
const { validateDate } = require('../utils/validators');
const {
    calcularDispersion,
    calcularAmplitud,
    calcularCalidadPrecio,
    generarRecomendacionGlobal
} = require('../utils/omnesCalculator');

/**
 * Normaliza el rango de fechas. Si ambos son válidos devuelve { desde, hasta };
 * si no, devuelve null para indicar "histórico completo".
 */
function resolverPeriodo(desde, hasta) {
    if (!desde && !hasta) return null;
    const d = validateDate(desde);
    const h = validateDate(hasta);
    if (!d.valid || !h.valid) return null;
    return { desde, hasta };
}

/**
 * Ejecuta la lógica completa de /analysis/menu-engineering.
 *
 * @param {Pool} pool
 * @param {number} restauranteId
 * @param {{ desde?: string, hasta?: string }} opts
 * @returns {Promise<Array>} platos clasificados con clasificacion y metricas
 */
async function getMenuEngineering(pool, restauranteId, opts = {}) {
    const periodo = resolverPeriodo(opts.desde, opts.hasta);
    // BCG y Omnes deben analizar el MISMO universo de platos. Antes el BCG
    // excluía solo no-food (bebidas/base) y dejaba entrar los extras
    // (extra/tapa/pincho/guarnición/aperitivo), así que PAN POR PERSONA o un
    // ACEITE de 1,50€ salían como caballo/perro aunque NO son platos. Ahora
    // usa la misma exclusión que Omnes (omnesExcludedCategoriesSqlList, que es
    // superset de no-food + extras). Unificado 2026-06-09.
    const excludedList = omnesExcludedCategoriesSqlList();

    const ventasFiltroFecha = periodo ? `AND v.fecha >= $2 AND v.fecha < $3` : '';
    const ventasParams = periodo
        ? [restauranteId, periodo.desde, periodo.hasta]
        : [restauranteId];

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
           AND LOWER(TRIM(COALESCE(r.categoria, ''))) NOT IN (${excludedList})
         GROUP BY r.id, r.nombre, r.categoria, r.precio_venta, r.ingredientes, r.porciones`,
        ventasParams
    );

    if (ventas.rows.length === 0) return [];

    const ingredientesResult = await pool.query(
        `SELECT i.id, i.precio, i.cantidad_por_formato, i.rendimiento, i.precio_fijado,
                pcd.precio_medio_compra
         FROM ingredientes i
         LEFT JOIN (
             SELECT ingrediente_id,
                    ROUND((SUM(total_compra) / NULLIF(SUM(cantidad_comprada), 0))::numeric, 4) as precio_medio_compra
             FROM precios_compra_diarios WHERE restaurante_id = $1
             GROUP BY ingrediente_id
         ) pcd ON pcd.ingrediente_id = i.id
         WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL`,
        [restauranteId]
    );
    const preciosMap = new Map();
    const rendimientoBaseMap = new Map();
    ingredientesResult.rows.forEach(ing => {
        preciosMap.set(ing.id, getBackendIngredientUnitPrice(ing));
        if (ing.rendimiento) {
            rendimientoBaseMap.set(ing.id, parseFloat(ing.rendimiento));
        }
    });

    const todasRecetasResult = await pool.query(
        'SELECT id, porciones, ingredientes FROM recetas WHERE restaurante_id = $1 AND deleted_at IS NULL',
        [restauranteId]
    );
    const recetasMap = new Map(todasRecetasResult.rows.map(r => [r.id, r]));

    const analisis = [];
    const ventasConDatos = ventas.rows.filter(v => parseFloat(v.cantidad_vendida) > 0);
    const totalVentasRestaurante = ventasConDatos.reduce((sum, v) => sum + parseFloat(v.cantidad_vendida), 0);
    const promedioPopularidad = ventasConDatos.length > 0 ? totalVentasRestaurante / ventasConDatos.length : 0;
    let sumaMargenes = 0;

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
    const platosConVentas = analisis.filter(p => p.popularidad > 0);
    const promedioFoodCost = platosConVentas.length > 0
        ? platosConVentas.reduce((sum, p) => sum + p.foodCost, 0) / platosConVentas.length
        : 0;

    return analisis.map(p => {
        const esPopular = p.popularidad >= (promedioPopularidad * 0.7);
        const esRentable = p.margen >= promedioMargen;
        const foodCostAlto = p.foodCost > 40;

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
}

/**
 * Ejecuta la lógica completa de /analysis/omnes.
 *
 * @param {Pool} pool
 * @param {number} restauranteId
 * @param {{ desde?: string, hasta?: string }} opts
 * @returns {Promise<object>} { periodo, dispersion, amplitud, calidad_precio, recomendacion_global }
 */
async function getOmnesAnalysis(pool, restauranteId, opts = {}) {
    const periodo = resolverPeriodo(opts.desde, opts.hasta);
    // Iker 2026-06-09: el análisis de Omnes mide la estrategia de carta
    // como un cliente normal la percibe — pidiendo platos principales. Por
    // eso excluimos bebidas, suministros/base (no se venden directamente),
    // Y además extras semánticos (pincho, aperitivo, tapa, extra, guarnición,
    // aceite). Si entraran al cálculo, un PAN POR PERSONA a 1€ o una OSTRA a
    // 4€ inflarían la dispersión sin que reflejen una decisión real de carta.
    const excludedList = omnesExcludedCategoriesSqlList();

    const ventasFiltroFecha = periodo ? `AND v.fecha >= $2 AND v.fecha < $3` : '';
    const ventasParams = periodo
        ? [restauranteId, periodo.desde, periodo.hasta]
        : [restauranteId];

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
           AND LOWER(TRIM(COALESCE(r.categoria, ''))) NOT IN (${excludedList})
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

    return {
        periodo: periodo || { desde: null, hasta: null },
        dispersion,
        amplitud,
        calidad_precio: calidadPrecio,
        recomendacion_global: recomendacion
    };
}

module.exports = {
    resolverPeriodo,
    getMenuEngineering,
    getOmnesAnalysis
};
