/**
 * ============================================
 * routes/analytics.routes.js - Rutas de Analytics
 * ============================================
 *
 * Menu Engineering, Balance, Comparativas, Daily tracking
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const express = require('express');
const router = express.Router();

const { pool } = require('../config/database');
const { log } = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth');

// ========== MENU ENGINEERING ==========

/**
 * GET /api/analytics/menu-engineering
 * Análisis de rentabilidad y popularidad del menú
 */
router.get('/menu-engineering', authMiddleware, async (req, res) => {
    try {
        const ventas = await pool.query(
            `SELECT r.id, r.nombre, r.categoria, r.precio_venta, r.ingredientes,
                    SUM(v.cantidad) as cantidad_vendida, SUM(v.total) as total_ventas
             FROM ventas v JOIN recetas r ON v.receta_id = r.id
             WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
             GROUP BY r.id, r.nombre, r.categoria, r.precio_venta, r.ingredientes`,
            [req.restauranteId]
        );

        if (ventas.rows.length === 0) return res.json([]);

        // Precios unitarios de ingredientes
        const ingredientesResult = await pool.query(
            'SELECT id, precio, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1',
            [req.restauranteId]
        );
        const preciosMap = new Map();
        ingredientesResult.rows.forEach(ing => {
            const precioFormato = parseFloat(ing.precio) || 0;
            const cantidadPorFormato = parseFloat(ing.cantidad_por_formato) || 1;
            preciosMap.set(ing.id, precioFormato / cantidadPorFormato);
        });

        const totalVentasRestaurante = ventas.rows.reduce((sum, v) => sum + parseFloat(v.cantidad_vendida), 0);
        const promedioPopularidad = ventas.rows.length > 0 ? totalVentasRestaurante / ventas.rows.length : 0;
        let sumaMargenes = 0;

        const analisis = [];
        for (const plato of ventas.rows) {
            let costePlato = 0;
            for (const ing of (plato.ingredientes || [])) {
                costePlato += (preciosMap.get(ing.ingredienteId) || 0) * (ing.cantidad || 0);
            }

            const margenContribucion = parseFloat(plato.precio_venta) - costePlato;
            sumaMargenes += margenContribucion * parseFloat(plato.cantidad_vendida);

            analisis.push({
                id: plato.id, nombre: plato.nombre, categoria: plato.categoria,
                precio_venta: plato.precio_venta, cantidad_vendida: plato.cantidad_vendida,
                total_ventas: plato.total_ventas, coste: costePlato, margen: margenContribucion,
                foodCost: parseFloat(plato.precio_venta) > 0 ? (costePlato / parseFloat(plato.precio_venta)) * 100 : 0,
                popularidad: parseFloat(plato.cantidad_vendida)
            });
        }

        const promedioMargen = totalVentasRestaurante > 0 ? sumaMargenes / totalVentasRestaurante : 0;

        const resultado = analisis.map(p => {
            const esPopular = p.popularidad >= (promedioPopularidad * 0.7);
            const esRentable = p.margen >= promedioMargen;
            let clasificacion = 'perro';
            if (esPopular && esRentable) clasificacion = 'estrella';
            else if (esPopular && !esRentable) clasificacion = 'caballo';
            else if (!esPopular && esRentable) clasificacion = 'puzzle';

            return { ...p, clasificacion, metricas: { esPopular, esRentable, promedioPopularidad, promedioMargen } };
        });

        res.json(resultado);
    } catch (err) {
        log('error', 'Error análisis menú', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

// ========== BALANCE MENSUAL ==========

/**
 * GET /api/analytics/balance/mes
 * Balance mensual (ingresos, costos, ganancia)
 */
router.get('/balance/mes', authMiddleware, async (req, res) => {
    try {
        const { mes, ano } = req.query;
        const mesActual = mes || new Date().getMonth() + 1;
        const anoActual = ano || new Date().getFullYear();

        const ventasMes = await pool.query(
            `SELECT COALESCE(SUM(total), 0) as ingresos, COUNT(*) as num_ventas
             FROM ventas WHERE EXTRACT(MONTH FROM fecha) = $1 AND EXTRACT(YEAR FROM fecha) = $2 
             AND restaurante_id = $3 AND deleted_at IS NULL`,
            [mesActual, anoActual, req.restauranteId]
        );

        const ventasDetalle = await pool.query(
            `SELECT v.cantidad, r.ingredientes FROM ventas v JOIN recetas r ON v.receta_id = r.id
             WHERE EXTRACT(MONTH FROM v.fecha) = $1 AND EXTRACT(YEAR FROM v.fecha) = $2 
             AND v.restaurante_id = $3 AND v.deleted_at IS NULL AND r.deleted_at IS NULL`,
            [mesActual, anoActual, req.restauranteId]
        );

        const ingredientesResult = await pool.query(
            'SELECT id, precio FROM ingredientes WHERE restaurante_id = $1', [req.restauranteId]
        );
        const preciosMap = new Map();
        ingredientesResult.rows.forEach(i => preciosMap.set(i.id, parseFloat(i.precio) || 0));

        let costos = 0;
        for (const venta of ventasDetalle.rows) {
            for (const ing of (venta.ingredientes || [])) {
                costos += (preciosMap.get(ing.ingredienteId) || 0) * (ing.cantidad || 0) * venta.cantidad;
            }
        }

        const ingresos = parseFloat(ventasMes.rows[0].ingresos) || 0;
        const ganancia = ingresos - costos;
        const margen = ingresos > 0 ? ((ganancia / ingresos) * 100).toFixed(1) : 0;

        const platoMasVendido = await pool.query(
            `SELECT r.nombre, SUM(v.cantidad) as total_vendido FROM ventas v JOIN recetas r ON v.receta_id = r.id
             WHERE EXTRACT(MONTH FROM v.fecha) = $1 AND EXTRACT(YEAR FROM v.fecha) = $2 
             AND v.restaurante_id = $3 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
             GROUP BY r.nombre ORDER BY total_vendido DESC LIMIT 1`,
            [mesActual, anoActual, req.restauranteId]
        );

        const valorInventario = await pool.query(
            'SELECT COALESCE(SUM(stock_actual * precio), 0) as valor FROM ingredientes WHERE restaurante_id = $1',
            [req.restauranteId]
        );

        res.json({
            ingresos, costos, ganancia, margen: parseFloat(margen),
            num_ventas: parseInt(ventasMes.rows[0].num_ventas) || 0,
            plato_mas_vendido: platoMasVendido.rows[0] || null,
            valor_inventario: parseFloat(valorInventario.rows[0].valor) || 0
        });
    } catch (err) {
        log('error', 'Error balance', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * GET /api/analytics/balance/comparativa
 * Comparativa últimos 12 meses
 */
router.get('/balance/comparativa', authMiddleware, async (req, res) => {
    try {
        const meses = await pool.query(
            `SELECT TO_CHAR(fecha, 'YYYY-MM') as mes, SUM(total) as ingresos, COUNT(*) as num_ventas
             FROM ventas WHERE restaurante_id = $1 AND deleted_at IS NULL
             GROUP BY TO_CHAR(fecha, 'YYYY-MM') ORDER BY mes DESC LIMIT 12`,
            [req.restauranteId]
        );
        res.json(meses.rows || []);
    } catch (err) {
        log('error', 'Error comparativa', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

// ========== DAILY TRACKING ==========

/**
 * GET /api/analytics/daily/purchases
 * Precios de compra diarios
 */
router.get('/daily/purchases', authMiddleware, async (req, res) => {
    try {
        const { fecha, mes, ano } = req.query;
        let query = `
            SELECT p.*, i.nombre as ingrediente_nombre, i.unidad, pr.nombre as proveedor_nombre
            FROM precios_compra_diarios p
            LEFT JOIN ingredientes i ON p.ingrediente_id = i.id
            LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
            WHERE p.restaurante_id = $1`;
        let params = [req.restauranteId];

        if (fecha) { query += ' AND p.fecha = $2'; params.push(fecha); }
        else if (mes && ano) {
            query += ' AND EXTRACT(MONTH FROM p.fecha) = $2 AND EXTRACT(YEAR FROM p.fecha) = $3';
            params.push(mes, ano);
        }

        query += ' ORDER BY p.fecha DESC, i.nombre';
        const result = await pool.query(query, params);
        res.json(result.rows || []);
    } catch (err) {
        log('error', 'Error compras diarias', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

/**
 * GET /api/analytics/daily/sales
 * Ventas diarias resumen
 */
router.get('/daily/sales', authMiddleware, async (req, res) => {
    try {
        const { fecha, mes, ano } = req.query;
        let query = `
            SELECT v.*, r.nombre as receta_nombre, r.categoria
            FROM ventas_diarias_resumen v
            LEFT JOIN recetas r ON v.receta_id = r.id
            WHERE v.restaurante_id = $1`;
        let params = [req.restauranteId];

        if (fecha) { query += ' AND v.fecha = $2'; params.push(fecha); }
        else if (mes && ano) {
            query += ' AND EXTRACT(MONTH FROM v.fecha) = $2 AND EXTRACT(YEAR FROM v.fecha) = $3';
            params.push(mes, ano);
        }

        query += ' ORDER BY v.fecha DESC, r.nombre';
        const result = await pool.query(query, params);
        res.json(result.rows || []);
    } catch (err) {
        log('error', 'Error ventas diarias', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

/**
 * POST /api/analytics/daily/purchases/bulk
 * Importar compras masivas (n8n)
 */
router.post('/daily/purchases/bulk', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { compras } = req.body;
        if (!Array.isArray(compras)) {
            return res.status(400).json({ error: 'Array compras requerido' });
        }

        await client.query('BEGIN');
        const resultados = { procesados: 0, fallidos: 0, errores: [] };

        const normalizar = (str) => (str || '').toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

        const ingredientesResult = await client.query(
            'SELECT id, nombre, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1',
            [req.restauranteId]
        );
        const ingredientesMap = new Map();
        ingredientesResult.rows.forEach(i => {
            ingredientesMap.set(normalizar(i.nombre), { id: i.id, cantidadPorFormato: parseFloat(i.cantidad_por_formato) || 0 });
        });

        for (const compra of compras) {
            const nombreNormalizado = normalizar(compra.ingrediente);
            let ingredienteData = ingredientesMap.get(nombreNormalizado);

            if (!ingredienteData) {
                for (const [nombreDB, data] of ingredientesMap) {
                    if (nombreDB.includes(nombreNormalizado) || nombreNormalizado.includes(nombreDB)) {
                        ingredienteData = data; break;
                    }
                }
            }

            if (!ingredienteData) {
                resultados.fallidos++;
                resultados.errores.push({ ingrediente: compra.ingrediente, error: 'No encontrado' });
                continue;
            }

            const precio = parseFloat(compra.precio) || 0;
            const cantidad = parseFloat(compra.cantidad) || 0;
            const fecha = compra.fecha || new Date().toISOString().split('T')[0];

            await client.query(`
                INSERT INTO precios_compra_diarios (ingrediente_id, fecha, precio_unitario, cantidad_comprada, total_compra, restaurante_id)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (ingrediente_id, fecha, restaurante_id) DO UPDATE SET 
                    precio_unitario = EXCLUDED.precio_unitario,
                    cantidad_comprada = precios_compra_diarios.cantidad_comprada + EXCLUDED.cantidad_comprada,
                    total_compra = precios_compra_diarios.total_compra + EXCLUDED.total_compra
            `, [ingredienteData.id, fecha, precio, cantidad, precio * cantidad, req.restauranteId]);

            const stockASumar = ingredienteData.cantidadPorFormato > 0 ? cantidad * ingredienteData.cantidadPorFormato : cantidad;
            await client.query('UPDATE ingredientes SET stock_actual = stock_actual + $1 WHERE id = $2', [stockASumar, ingredienteData.id]);

            resultados.procesados++;
        }

        await client.query('COMMIT');
        log('info', 'Compras importadas', { procesados: resultados.procesados, fallidos: resultados.fallidos });
        res.json(resultados);
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error bulk compras', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

module.exports = router;
