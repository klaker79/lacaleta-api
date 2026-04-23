/**
 * Daily Routes — Simple read/update endpoints for daily data.
 *
 * Extracted from balance.routes.js on 2026-04-20 to keep that file under
 * a manageable size. These endpoints read/update day-level tables.
 *
 * Endpoints:
 *   - GET  /daily/purchases         — daily purchase aggregates (tabla precios_compra_diarios)
 *   - PUT  /daily/purchases/correct — admin-style fix for a mis-entered daily purchase
 *   - GET  /daily/sales             — daily sales aggregates (tabla ventas_diarias_resumen)
 */

const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { log } = require('../utils/logger');

module.exports = function (pool) {
    const router = Router();

    // GET daily purchases aggregated (tabla precios_compra_diarios)
    router.get('/daily/purchases', authMiddleware, async (req, res) => {
        try {
            const { fecha, mes, ano } = req.query;
            let query = `
                SELECT p.ingrediente_id, p.fecha, p.restaurante_id,
                       i.nombre as ingrediente_nombre, i.unidad,
                       SUM(p.cantidad_comprada) as cantidad_comprada,
                       SUM(p.total_compra) as total_compra,
                       CASE WHEN SUM(p.cantidad_comprada) > 0
                            THEN SUM(p.total_compra) / SUM(p.cantidad_comprada)
                            ELSE MAX(p.precio_unitario)
                       END as precio_unitario,
                       MAX(pr.nombre) as proveedor_nombre,
                       MAX(p.proveedor_id) as proveedor_id,
                       MAX(p.id) as id,
                       MAX(p.pedido_id) as pedido_id,
                       MAX(p.created_at) as created_at,
                       MAX(p.notas) as notas
                FROM precios_compra_diarios p
                LEFT JOIN ingredientes i ON p.ingrediente_id = i.id
                LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
                WHERE p.restaurante_id = $1
            `;
            const params = [req.restauranteId];

            if (fecha) {
                query += ' AND p.fecha = $2';
                params.push(fecha);
            } else if (mes && ano) {
                const m = parseInt(mes), y = parseInt(ano);
                const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
                const nm = m === 12 ? 1 : m + 1;
                const ny = m === 12 ? y + 1 : y;
                const endDate = `${ny}-${String(nm).padStart(2, '0')}-01`;
                query += ' AND p.fecha >= $2 AND p.fecha < $3';
                params.push(startDate, endDate);
            }

            query += ' GROUP BY p.ingrediente_id, p.fecha, p.restaurante_id, i.nombre, i.unidad';
            query += ' ORDER BY p.fecha DESC, i.nombre';

            const result = await pool.query(query, params);
            res.json(result.rows || []);
        } catch (err) {
            log('error', 'Error obteniendo compras diarias', { error: err.message });
            res.status(500).json({ error: 'Error interno', data: [] });
        }
    });

    // PUT fix a daily purchase entry (precios_compra_diarios)
    router.put('/daily/purchases/correct', authMiddleware, async (req, res) => {
        try {
            const { ingredienteId, fecha, cantidad, total } = req.body;
            if (!ingredienteId || !fecha) {
                return res.status(400).json({ error: 'ingredienteId y fecha son obligatorios' });
            }
            const result = await pool.query(
                `UPDATE precios_compra_diarios
                 SET cantidad_comprada = $1, total_compra = $2
                 WHERE ingrediente_id = $3 AND fecha = $4 AND restaurante_id = $5
                 RETURNING *`,
                [cantidad, total, ingredienteId, fecha, req.restauranteId]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Registro no encontrado' });
            }
            log('info', 'Compra diaria corregida', { ingredienteId, fecha, cantidad, total });
            res.json({ success: true, updated: result.rows[0] });
        } catch (err) {
            log('error', 'Error corrigiendo compra diaria', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // GET daily sales (tabla ventas_diarias_resumen)
    router.get('/daily/sales', authMiddleware, async (req, res) => {
        try {
            const { fecha, mes, ano } = req.query;
            let query = `
                SELECT v.*, r.nombre as receta_nombre, r.categoria
                FROM ventas_diarias_resumen v
                LEFT JOIN recetas r ON v.receta_id = r.id
                WHERE v.restaurante_id = $1
            `;
            const params = [req.restauranteId];

            if (fecha) {
                query += ' AND v.fecha = $2';
                params.push(fecha);
            } else if (mes && ano) {
                const m = parseInt(mes), y = parseInt(ano);
                const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
                const nm = m === 12 ? 1 : m + 1;
                const ny = m === 12 ? y + 1 : y;
                const endDate = `${ny}-${String(nm).padStart(2, '0')}-01`;
                query += ' AND v.fecha >= $2 AND v.fecha < $3';
                params.push(startDate, endDate);
            }

            query += ' ORDER BY v.fecha DESC, r.nombre';

            const result = await pool.query(query, params);
            res.json(result.rows || []);
        } catch (err) {
            log('error', 'Error obteniendo ventas diarias', { error: err.message });
            res.status(500).json({ error: 'Error interno', data: [] });
        }
    });

    return router;
};
