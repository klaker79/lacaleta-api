/**
 * system Routes — Extracted from server.js
 * Health check, 404 handler, backup endpoint
 */
const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { log } = require('../utils/logger');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function(pool) {
    const router = Router();

// ========== HEALTH CHECK ENDPOINT (READ ONLY) ==========
router.get('/system/health-check', authMiddleware, async (req, res) => {
    try {
        const restauranteId = req.restauranteId;
        const results = {};

        // 1. Conexión DB
        try {
            await pool.query('SELECT 1');
            results.database = { ok: true, message: 'Conexión OK' };
        } catch (err) {
            results.database = { ok: false, message: 'Error de conexión a BD' };
        }

        // 2. Recetas sin ingredientes
        const recetasSinIng = await pool.query(`
            SELECT id, nombre FROM recetas 
            WHERE restaurante_id = $1 AND deleted_at IS NULL
            AND (ingredientes IS NULL OR ingredientes::text = '[]')
        `, [restauranteId]);
        results.recetasSinIngredientes = {
            ok: recetasSinIng.rows.length === 0,
            count: recetasSinIng.rows.length,
            items: recetasSinIng.rows.slice(0, 10)
        };

        // 3. Stock negativo
        const stockNegativo = await pool.query(`
            SELECT id, nombre, stock_actual, unidad FROM ingredientes 
            WHERE restaurante_id = $1 AND stock_actual < 0
            ORDER BY stock_actual LIMIT 10
        `, [restauranteId]);
        results.stockNegativo = {
            ok: stockNegativo.rows.length === 0,
            count: stockNegativo.rows.length,
            items: stockNegativo.rows
        };

        // 4. Vinos sin ingrediente
        const vinosSinIng = await pool.query(`
            SELECT id, nombre FROM recetas 
            WHERE restaurante_id = $1 AND deleted_at IS NULL
            AND nombre ILIKE '%vino%'
            AND (ingredientes IS NULL OR ingredientes::text = '[]')
        `, [restauranteId]);
        results.vinosSinIngrediente = {
            ok: vinosSinIng.rows.length === 0,
            count: vinosSinIng.rows.length,
            items: vinosSinIng.rows
        };

        // 5. Valor Stock
        const valorStock = await pool.query(`
            SELECT 
                SUM(stock_actual * (precio / COALESCE(NULLIF(cantidad_por_formato, 0), 1))) as valor,
                COUNT(*) as items
            FROM ingredientes WHERE restaurante_id = $1 AND stock_actual > 0
        `, [restauranteId]);
        results.valorStock = {
            valor: parseFloat(valorStock.rows[0].valor) || 0,
            items: parseInt(valorStock.rows[0].items) || 0
        };

        // 6. Ventas hoy
        const today = new Date().toISOString().split('T')[0];
        const ventasHoy = await pool.query(`
            SELECT COUNT(*) as num, COALESCE(SUM(total), 0) as total
            FROM ventas WHERE restaurante_id = $1 AND fecha::date = $2 AND deleted_at IS NULL
        `, [restauranteId, today]);
        results.ventasHoy = {
            fecha: today,
            num_ventas: parseInt(ventasHoy.rows[0].num),
            total: parseFloat(ventasHoy.rows[0].total)
        };

        // Resumen
        const allOk = results.database.ok &&
            results.recetasSinIngredientes.ok &&
            results.stockNegativo.ok &&
            results.vinosSinIngrediente.ok;

        res.json({
            status: allOk ? 'healthy' : 'issues_detected',
            timestamp: new Date().toISOString(),
            restauranteId,
            checks: results
        });
    } catch (err) {
        log('error', 'Error en health-check', { error: err.message });
        res.status(500).json({ error: 'Error ejecutando health check' });
    }
});

// ========== 404 ==========
app.use((req, res) => {
    res.status(404).json({
        error: 'Ruta no encontrada'
    });
});



// ========== BACKUP ENDPOINT ==========
router.get('/backup', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const restauranteId = req.restauranteId;
        log('info', 'Backup solicitado', { restauranteId, usuario: req.user?.email });

        // Tablas a exportar (solo datos del restaurante autenticado)
        const tables = [
            { name: 'ingredientes', query: 'SELECT * FROM ingredientes WHERE restaurante_id = $1 AND deleted_at IS NULL' },
            { name: 'recetas', query: 'SELECT * FROM recetas WHERE restaurante_id = $1 AND deleted_at IS NULL' },
            { name: 'recetas_variantes', query: 'SELECT rv.* FROM recetas_variantes rv JOIN recetas r ON rv.receta_id = r.id WHERE r.restaurante_id = $1 AND r.deleted_at IS NULL' },
            { name: 'proveedores', query: 'SELECT * FROM proveedores WHERE restaurante_id = $1' },
            { name: 'ingredientes_proveedores', query: 'SELECT ip.* FROM ingredientes_proveedores ip JOIN ingredientes i ON ip.ingrediente_id = i.id WHERE i.restaurante_id = $1' },
            { name: 'pedidos', query: 'SELECT * FROM pedidos WHERE restaurante_id = $1 AND deleted_at IS NULL ORDER BY fecha DESC LIMIT 500' },
            { name: 'ventas', query: 'SELECT * FROM ventas WHERE restaurante_id = $1 AND deleted_at IS NULL ORDER BY fecha DESC LIMIT 1000' },
            { name: 'inventario', query: 'SELECT * FROM inventario WHERE restaurante_id = $1 ORDER BY fecha DESC LIMIT 500' },
            { name: 'empleados', query: 'SELECT id, nombre, puesto, salario_hora, activo, restaurante_id FROM empleados WHERE restaurante_id = $1' },
            { name: 'horarios', query: 'SELECT * FROM horarios WHERE restaurante_id = $1 ORDER BY fecha DESC LIMIT 200' },
            { name: 'gastos_fijos', query: 'SELECT * FROM gastos_fijos WHERE restaurante_id = $1' },
            { name: 'mermas', query: 'SELECT * FROM mermas WHERE restaurante_id = $1 AND deleted_at IS NULL ORDER BY fecha DESC LIMIT 500' },
        ];

        const backup = {
            metadata: {
                version: '1.0',
                restauranteId,
                fecha: new Date().toISOString(),
                app: 'MindLoop CostOS',
            },
            data: {}
        };

        for (const table of tables) {
            try {
                const result = await pool.query(table.query, [restauranteId]);
                backup.data[table.name] = result.rows;
            } catch (tableErr) {
                // Si una tabla no existe o falla, continuar con las demás
                log('warn', `Backup: tabla ${table.name} falló`, { error: tableErr.message });
                backup.data[table.name] = [];
            }
        }

        // Conteo de registros
        backup.metadata.registros = {};
        for (const [tableName, rows] of Object.entries(backup.data)) {
            backup.metadata.registros[tableName] = rows.length;
        }
        backup.metadata.totalRegistros = Object.values(backup.metadata.registros).reduce((a, b) => a + b, 0);

        // Enviar como JSON descargable
        const filename = `backup-costos-${restauranteId}-${new Date().toISOString().split('T')[0]}.json`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/json');
        res.json(backup);

        log('info', 'Backup completado', { restauranteId, registros: backup.metadata.totalRegistros });
    } catch (err) {
        log('error', 'Error generando backup', { error: err.message });
        res.status(500).json({ error: 'Error generando backup' });
    }
});


    return router;
};
