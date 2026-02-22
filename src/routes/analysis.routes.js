/**
 * analysis Routes — Extracted from server.js
 * Menu engineering analysis (BCG matrix)
 */
const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { log } = require('../utils/logger');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function(pool) {
    const router = Router();

// ========== ANÁLISIS AVANZADO ==========
router.get('/analysis/menu-engineering', authMiddleware, async (req, res) => {
    try {
        // Query 1: Ventas agrupadas por receta
        const ventas = await pool.query(
            `SELECT r.id, r.nombre, r.categoria, r.precio_venta, r.ingredientes,
                    SUM(v.cantidad) as cantidad_vendida,
                    SUM(v.total) as total_ventas
             FROM ventas v
             JOIN recetas r ON v.receta_id = r.id
             WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
               AND LOWER(COALESCE(r.categoria, '')) NOT IN ('bebidas', 'bebida')
             GROUP BY r.id, r.nombre, r.categoria, r.precio_venta, r.ingredientes`,
            [req.restauranteId]
        );

        if (ventas.rows.length === 0) {
            return res.json([]);
        }

        // Query 2: Todos los precios de ingredientes en UNA query
        // 🔧 FIX: Incluir cantidad_por_formato para calcular precio UNITARIO
        const ingredientesResult = await pool.query(
            'SELECT id, precio, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1 AND deleted_at IS NULL',
            [req.restauranteId]
        );
        const preciosMap = new Map();
        ingredientesResult.rows.forEach(ing => {
            // ✅ Precio unitario = precio del formato / cantidad en el formato
            const precioFormato = parseFloat(ing.precio) || 0;
            const cantidadPorFormato = parseFloat(ing.cantidad_por_formato) || 1;
            const precioUnitario = precioFormato / cantidadPorFormato;
            preciosMap.set(ing.id, precioUnitario);
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
                    costePlato += precioIng * (ing.cantidad || 0);
                }
            }

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
