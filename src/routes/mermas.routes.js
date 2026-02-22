/**
 * mermas Routes — Extracted from server.js
 * Waste (mermas) tracking: register, intelligence, history, monthly summary, delete, monthly reset
 */
const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { sanitizeString, validateId } = require('../utils/validators');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== 🗑️ MERMAS - REGISTRO ==========
    router.post('/mermas', authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            const { mermas } = req.body;
            log('info', 'Recibiendo mermas', {
                count: mermas?.length,
                restauranteId: req.restauranteId,
                body: JSON.stringify(mermas).substring(0, 500)
            });

            if (!mermas || !Array.isArray(mermas)) {
                return res.status(400).json({ error: 'Se requiere array de mermas' });
            }

            await client.query('BEGIN');

            let insertados = 0;
            for (const m of mermas) {
                // Validar que ingredienteId existe o usar NULL
                const ingredienteId = m.ingredienteId ? parseInt(m.ingredienteId) : null;

                // Calcular periodo_id como YYYYMM (ej: 202601 para enero 2026)
                const now = new Date();
                const periodoId = now.getFullYear() * 100 + (now.getMonth() + 1);

                await client.query(`
                INSERT INTO mermas 
                (ingrediente_id, ingrediente_nombre, cantidad, unidad, valor_perdida, motivo, nota, responsable_id, restaurante_id, periodo_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [
                    ingredienteId,
                    sanitizeString(m.ingredienteNombre) || 'Sin nombre',
                    parseFloat(m.cantidad) || 0,
                    sanitizeString(m.unidad) || 'ud',
                    parseFloat(m.valorPerdida) || 0,
                    sanitizeString(m.motivo) || 'Otros',
                    sanitizeString(m.nota) || '',
                    m.responsableId ? parseInt(m.responsableId) : null,
                    req.restauranteId,
                    periodoId
                ]);

                // Descontar stock del ingrediente (simétrico con la restauración en DELETE /api/mermas/:id)
                if (ingredienteId && parseFloat(m.cantidad) > 0) {
                    await client.query('SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE', [ingredienteId, req.restauranteId]);
                    await client.query(
                        `UPDATE ingredientes SET stock_actual = GREATEST(0, stock_actual - $1), ultima_actualizacion_stock = NOW()
                     WHERE id = $2 AND restaurante_id = $3`,
                        [parseFloat(m.cantidad), ingredienteId, req.restauranteId]
                    );
                    log('info', 'Stock descontado por merma', { ingredienteId, cantidad: m.cantidad });
                }

                insertados++;
            }

            await client.query('COMMIT');
            log('info', `Registradas ${insertados}/${mermas.length} mermas`, { restauranteId: req.restauranteId });
            res.json({ success: true, count: insertados });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error registrando mermas', {
                error: err.message,
                stack: err.stack,
                mermasCount: req.body?.mermas?.length || 0
            });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    // ========== 🧠 INTELIGENCIA - MERMAS ==========
    router.get('/intelligence/waste-stats', authMiddleware, async (req, res) => {
        try {
            // Total mermas este mes
            const mesActual = await pool.query(`
            SELECT 
                COALESCE(SUM(valor_perdida), 0) as total_perdida,
                COUNT(*) as total_registros
            FROM mermas
            WHERE restaurante_id = $1
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE)
              AND deleted_at IS NULL
        `, [req.restauranteId]);

            // Top 5 productos más tirados
            const topProductos = await pool.query(`
            SELECT 
                ingrediente_nombre as nombre,
                SUM(cantidad) as cantidad_total,
                SUM(valor_perdida) as perdida_total,
                COUNT(*) as veces
            FROM mermas
            WHERE restaurante_id = $1
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE)
              AND deleted_at IS NULL
            GROUP BY ingrediente_nombre
            ORDER BY perdida_total DESC
            LIMIT 5
        `, [req.restauranteId]);

            // Comparación con mes anterior
            const mesAnterior = await pool.query(`
            SELECT COALESCE(SUM(valor_perdida), 0) as total_perdida
            FROM mermas
            WHERE restaurante_id = $1
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
              AND fecha < DATE_TRUNC('month', CURRENT_DATE)
              AND deleted_at IS NULL
        `, [req.restauranteId]);

            const totalActual = parseFloat(mesActual.rows[0]?.total_perdida || 0);
            const totalAnterior = parseFloat(mesAnterior.rows[0]?.total_perdida || 0);
            const variacion = totalAnterior > 0 ? ((totalActual - totalAnterior) / totalAnterior) * 100 : 0;

            res.json({
                mes_actual: {
                    total_perdida: totalActual,
                    registros: parseInt(mesActual.rows[0]?.total_registros || 0)
                },
                top_productos: topProductos.rows,
                comparacion: {
                    mes_anterior: totalAnterior,
                    variacion: Math.round(variacion)
                }
            });
        } catch (err) {
            log('error', 'Error en intelligence/waste-stats', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== 🗑️ MERMAS - LISTAR HISTORIAL ==========
    router.get('/mermas', authMiddleware, async (req, res) => {
        try {
            const { mes, ano, limite } = req.query;
            const mesActual = parseInt(mes) || new Date().getMonth() + 1;
            const anoActual = parseInt(ano) || new Date().getFullYear();
            const lim = Math.min(parseInt(limite) || 100, 500);

            log('info', 'GET /api/mermas - Buscando mermas', {
                restauranteId: req.restauranteId,
                mes: mesActual,
                ano: anoActual,
                limite: lim,
                queryParams: req.query
            });

            // Primero, contar TODAS las mermas del restaurante sin filtro de fecha
            const countAll = await pool.query(`
            SELECT COUNT(*) as total FROM mermas WHERE restaurante_id = $1 AND deleted_at IS NULL
        `, [req.restauranteId]);

            log('info', `Total mermas en BD para restaurante ${req.restauranteId}: ${countAll.rows[0].total}`);

            // DEBUG REMOVIDO - Logs excesivos ya no necesarios después de depuración
            /*
            // DEBUG: Obtener la última merma para ver qué fecha tiene
            if (parseInt(countAll.rows[0].total) > 0) {
                const ultimaMerma = await pool.query(`
                    SELECT id, fecha, EXTRACT(MONTH FROM fecha) as mes_db, EXTRACT(YEAR FROM fecha) as ano_db
                    FROM mermas 
                    WHERE restaurante_id = $1
                    ORDER BY id DESC LIMIT 1
                `, [req.restauranteId]);
     
                if (ultimaMerma.rows.length > 0) {
                    log('info', 'DEBUG - Última merma en BD', {
                        id: ultimaMerma.rows[0].id,
                        fecha: ultimaMerma.rows[0].fecha,
                        mes_en_db: ultimaMerma.rows[0].mes_db,
                        ano_en_db: ultimaMerma.rows[0].ano_db,
                        mes_buscado: mesActual,
                        ano_buscado: anoActual
                    });
                }
            }
     
            // DEBUG TEMPORAL: Quitar TODOS los filtros para confirmar que hay datos
            log('info', `DEBUG - req.restauranteId value: ${req.restauranteId} (type: ${typeof req.restauranteId})`);
            */

            const result = await pool.query(`
            SELECT 
                m.id,
                m.ingrediente_id,
                m.ingrediente_nombre,
                m.cantidad,
                m.unidad,
                m.valor_perdida,
                m.motivo,
                m.nota,
                m.fecha,
                m.restaurante_id,
                i.nombre as ingrediente_actual
            FROM mermas m
            LEFT JOIN ingredientes i ON m.ingrediente_id = i.id
            WHERE m.restaurante_id = $1 AND m.deleted_at IS NULL
            ORDER BY m.fecha DESC, m.id DESC
            LIMIT $2
        `, [req.restauranteId, lim]);

            // Log reducido para producción
            log('debug', 'Mermas listadas', { count: result.rows.length, restauranteId: req.restauranteId });

            res.json(result.rows || []);
        } catch (err) {
            log('error', 'Error listando mermas', { error: err.message, stack: err.stack });
            res.status(500).json({ error: 'Error interno', data: [] });
        }
    });

    // ========== 🗑️ MERMAS - RESUMEN MENSUAL ==========
    router.get('/mermas/resumen', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(`
            SELECT 
                COALESCE(SUM(valor_perdida), 0) as total_perdida,
                COUNT(DISTINCT ingrediente_id) as total_productos,
                COUNT(*) as total_registros
            FROM mermas
            WHERE restaurante_id = $1
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE)
              AND deleted_at IS NULL
        `, [req.restauranteId]);

            const data = result.rows[0] || {};
            res.json({
                totalPerdida: parseFloat(data.total_perdida || 0),
                totalProductos: parseInt(data.total_productos || 0),
                totalRegistros: parseInt(data.total_registros || 0)
            });
        } catch (err) {
            log('error', 'Error en mermas/resumen', { error: err.message });
            res.status(500).json({
                totalPerdida: 0,
                totalProductos: 0,
                totalRegistros: 0
            });
        }
    });

    // ========== 🗑️ MERMAS - RESET MENSUAL ==========
    router.delete('/mermas/reset', authMiddleware, requireAdmin, async (req, res) => {
        const client = await pool.connect();
        try {
            const { motivo } = req.body || {};
            await client.query('BEGIN');

            // Obtener mermas a resetear para restaurar stock
            const mermasToReset = await client.query(`
            SELECT id, ingrediente_id, cantidad 
            FROM mermas 
            WHERE restaurante_id = $1 
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE)
              AND deleted_at IS NULL
        `, [req.restauranteId]);

            // Restaurar stock de cada merma (con lock para evitar race condition)
            for (const merma of mermasToReset.rows) {
                if (merma.ingrediente_id && parseFloat(merma.cantidad) > 0) {
                    await client.query('SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE', [merma.ingrediente_id, req.restauranteId]);
                    await client.query(
                        'UPDATE ingredientes SET stock_actual = stock_actual + $1, ultima_actualizacion_stock = NOW() WHERE id = $2 AND restaurante_id = $3',
                        [parseFloat(merma.cantidad), merma.ingrediente_id, req.restauranteId]
                    );
                }
            }

            // Soft delete en vez de hard delete
            const deleted = await client.query(`
            UPDATE mermas SET deleted_at = CURRENT_TIMESTAMP
            WHERE restaurante_id = $1 
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE)
              AND deleted_at IS NULL
            RETURNING id
        `, [req.restauranteId]);

            await client.query('COMMIT');

            log('info', `Reset mermas: ${deleted.rowCount} registros soft-deleted + stock restaurado`, {
                restauranteId: req.restauranteId,
                motivo: motivo || 'manual'
            });

            res.json({
                success: true,
                eliminados: deleted.rowCount,
                motivo: motivo || 'manual'
            });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error en mermas/reset', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    // ========== 🗑️ MERMAS - BORRAR INDIVIDUAL ==========
    router.delete('/mermas/:id', authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            const idCheck = validateId(req.params.id);
            if (!idCheck.valid) {
                client.release();
                return res.status(400).json({ error: 'ID inválido' });
            }
            await client.query('BEGIN');

            // 1. Obtener la merma antes de borrarla
            const mermaResult = await client.query(
                'SELECT * FROM mermas WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL',
                [idCheck.value, req.restauranteId]
            );

            if (mermaResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Merma no encontrada' });
            }

            const merma = mermaResult.rows[0];

            // 2. Restaurar stock del ingrediente (sumar la cantidad que se había restado)
            if (merma.ingrediente_id && merma.cantidad > 0) {
                // ⚡ FIX Bug #7: Lock row before update to prevent race condition
                await client.query('SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE', [merma.ingrediente_id, req.restauranteId]);
                await client.query(
                    `UPDATE ingredientes
                 SET stock_actual = stock_actual + $1,
                     ultima_actualizacion_stock = NOW()
                 WHERE id = $2 AND restaurante_id = $3`,
                    [parseFloat(merma.cantidad), merma.ingrediente_id, req.restauranteId]
                );
                log('info', 'Stock restaurado por eliminación de merma', {
                    ingredienteId: merma.ingrediente_id,
                    cantidad: merma.cantidad
                });
            }

            // 3. SOFT DELETE de la merma (no borrar físicamente para tener historial)
            // ⚡ FIX Bug #6: Cambiar de HARD DELETE a SOFT DELETE
            await client.query(
                'UPDATE mermas SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1',
                [req.params.id]
            );

            await client.query('COMMIT');
            log('info', 'Merma eliminada (soft delete)', { id: req.params.id, ingrediente: merma.ingrediente_nombre });
            res.json({ success: true, message: 'Merma eliminada y stock restaurado' });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error eliminando merma', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });


    return router;
};
