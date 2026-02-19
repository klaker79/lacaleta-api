/**
 * balance Routes — Extracted from server.js
 * Balance, statistics, daily cost/sales tracking
 */
const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { log } = require('../utils/logger');
const crypto = require('crypto');
const { upsertCompraDiaria } = require('../utils/businessHelpers');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== BALANCE Y ESTADÍSTICAS ==========
    router.get('/balance/mes', authMiddleware, async (req, res) => {
        try {
            const { mes, ano } = req.query;
            const mesActual = parseInt(mes) || new Date().getMonth() + 1;
            const anoActual = parseInt(ano) || new Date().getFullYear();

            // Use date range instead of EXTRACT for index usage
            const startDate = `${anoActual}-${String(mesActual).padStart(2, '0')}-01`;
            const nextMonth = mesActual === 12 ? 1 : mesActual + 1;
            const nextYear = mesActual === 12 ? anoActual + 1 : anoActual;
            const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

            const ventasMes = await pool.query(
                `SELECT COALESCE(SUM(total), 0) as ingresos, COUNT(*) as num_ventas
       FROM ventas
       WHERE fecha >= $1 AND fecha < $2 AND restaurante_id = $3 AND deleted_at IS NULL`,
                [startDate, endDate, req.restauranteId]
            );

            const ventasDetalle = await pool.query(
                `SELECT v.cantidad, r.ingredientes
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE v.fecha >= $1 AND v.fecha < $2 AND v.restaurante_id = $3 AND v.deleted_at IS NULL AND r.deleted_at IS NULL`,
                [startDate, endDate, req.restauranteId]
            );

            // Precargar todos los precios de ingredientes en UNA query
            const ingredientesResult = await pool.query(
                'SELECT id, precio, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1',
                [req.restauranteId]
            );
            const preciosMap = new Map();
            ingredientesResult.rows.forEach(i => {
                const precio = parseFloat(i.precio) || 0;
                const cpf = parseFloat(i.cantidad_por_formato) || 1;
                preciosMap.set(i.id, precio / cpf);
            });

            // Calcular costos usando el Map (sin queries adicionales)
            let costos = 0;
            for (const venta of ventasDetalle.rows) {
                const ingredientes = venta.ingredientes || [];
                for (const ing of ingredientes) {
                    const precio = preciosMap.get(ing.ingredienteId) || 0;
                    costos += precio * (ing.cantidad || 0) * venta.cantidad;
                }
            }

            const ingresos = parseFloat(ventasMes.rows[0].ingresos) || 0;
            const ganancia = ingresos - costos;
            const margen = ingresos > 0 ? ((ganancia / ingresos) * 100).toFixed(1) : 0;

            const platoMasVendido = await pool.query(
                `SELECT r.nombre, SUM(v.cantidad) as total_vendido
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE v.fecha >= $1 AND v.fecha < $2 AND v.restaurante_id = $3 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
       GROUP BY r.nombre
       ORDER BY total_vendido DESC
       LIMIT 1`,
                [startDate, endDate, req.restauranteId]
            );

            const ventasPorPlato = await pool.query(
                `SELECT r.nombre, SUM(v.total) as total_ingresos, SUM(v.cantidad) as cantidad
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE v.fecha >= $1 AND v.fecha < $2 AND v.restaurante_id = $3 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
       GROUP BY r.nombre
       ORDER BY total_ingresos DESC`,
                [startDate, endDate, req.restauranteId]
            );

            const valorInventario = await pool.query(
                `SELECT COALESCE(SUM(stock_actual * precio), 0) as valor
       FROM ingredientes WHERE restaurante_id = $1`,
                [req.restauranteId]
            );

            res.json({
                ingresos,
                costos,
                ganancia,
                margen: parseFloat(margen),
                num_ventas: parseInt(ventasMes.rows[0].num_ventas) || 0,
                plato_mas_vendido: platoMasVendido.rows[0] || null,
                ventas_por_plato: ventasPorPlato.rows || [],
                valor_inventario: parseFloat(valorInventario.rows[0].valor) || 0
            });
        } catch (error) {
            log('error', 'Error obteniendo balance', { error: error.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.get('/balance/comparativa', authMiddleware, async (req, res) => {
        try {
            const meses = await pool.query(
                `SELECT 
         TO_CHAR(fecha, 'YYYY-MM') as mes,
         SUM(total) as ingresos,
         COUNT(*) as num_ventas
       FROM ventas
       WHERE restaurante_id = $1 AND deleted_at IS NULL
       GROUP BY TO_CHAR(fecha, 'YYYY-MM')
       ORDER BY mes DESC
       LIMIT 12`,
                [req.restauranteId]
            );
            res.json(meses.rows || []);
        } catch (error) {
            log('error', 'Error comparativa', { error: error.message });
            res.status(500).json({ error: 'Error interno', data: [] });
        }
    });

    // ========== TRACKING DIARIO DE COSTES/VENTAS ==========

    // Obtener precios de compra diarios
    router.get('/daily/purchases', authMiddleware, async (req, res) => {
        try {
            const { fecha, mes, ano } = req.query;
            let query = `
            SELECT p.ingrediente_id, p.fecha, p.restaurante_id,
                   i.nombre as ingrediente_nombre, i.unidad,
                   -- Agregar cantidades de múltiples pedidos del mismo día
                   SUM(p.cantidad_comprada) as cantidad_comprada,
                   SUM(p.total_compra) as total_compra,
                   -- Precio unitario ponderado: total / cantidad
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
            let params = [req.restauranteId];

            if (fecha) {
                query += ' AND p.fecha = $2';
                params.push(fecha);
            } else if (mes && ano) {
                const m = parseInt(mes), y = parseInt(ano);
                const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
                const nm = m === 12 ? 1 : m + 1, ny = m === 12 ? y + 1 : y;
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

    // ==========================================
    // 🔔 COMPRAS PENDIENTES (Cola de revisión)
    // ==========================================

    // POST: n8n envía compras aquí (van a cola de revisión, NO directamente al diario)
    router.post('/purchases/pending', authMiddleware, async (req, res) => {
        try {
            const { compras } = req.body;

            if (!Array.isArray(compras) || compras.length === 0) {
                return res.status(400).json({
                    error: 'Formato inválido: se esperaba un array "compras" no vacío',
                    ejemplo: { compras: [{ ingrediente: "Pulpo", precio: 26, cantidad: 10, fecha: "2025-12-17" }] }
                });
            }

            // Generar batch_id único para agrupar items del mismo albarán
            const batchId = require('crypto').randomUUID();

            // Función para normalizar nombres
            const normalizar = (str) => {
                return (str || '')
                    .toLowerCase()
                    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                    .replace(/[^a-z0-9\s]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
            };

            // Obtener ingredientes y alias para matching
            const ingredientesResult = await pool.query(
                'SELECT id, nombre FROM ingredientes WHERE restaurante_id = $1',
                [req.restauranteId]
            );
            const ingredientesMap = new Map();
            ingredientesResult.rows.forEach(i => {
                ingredientesMap.set(normalizar(i.nombre), i.id);
            });

            const aliasResult = await pool.query(
                `SELECT a.alias, a.ingrediente_id FROM ingredientes_alias a 
             JOIN ingredientes i ON a.ingrediente_id = i.id
             WHERE a.restaurante_id = $1`,
                [req.restauranteId]
            );
            const aliasMap = new Map();
            aliasResult.rows.forEach(a => {
                aliasMap.set(normalizar(a.alias), a.ingrediente_id);
            });

            const resultados = { recibidos: 0, batchId };
            const values = [];
            const placeholders = [];
            let paramIdx = 1;

            for (const compra of compras) {
                const nombreNorm = normalizar(compra.ingrediente);
                let ingredienteId = null;

                // Búsqueda exacta
                ingredienteId = ingredientesMap.get(nombreNorm) || null;

                // Búsqueda parcial en ingredientes
                if (!ingredienteId) {
                    for (const [nombreDB, id] of ingredientesMap) {
                        if (nombreDB.includes(nombreNorm) || nombreNorm.includes(nombreDB)) {
                            ingredienteId = id;
                            break;
                        }
                    }
                }

                // Búsqueda en alias
                if (!ingredienteId) {
                    ingredienteId = aliasMap.get(nombreNorm) || null;
                }

                // Búsqueda parcial en alias
                if (!ingredienteId) {
                    for (const [aliasNombre, id] of aliasMap) {
                        if (aliasNombre.includes(nombreNorm) || nombreNorm.includes(aliasNombre)) {
                            ingredienteId = id;
                            break;
                        }
                    }
                }

                const precio = Math.abs(parseFloat(compra.precio)) || 0;
                const cantidad = Math.abs(parseFloat(compra.cantidad)) || 0;
                let fecha = compra.fecha || new Date().toISOString().split('T')[0];

                // ⚡ FIX: Handle DD-MM-YY format (e.g. "19-02-26" -> "2026-02-19") from n8n
                if (typeof fecha === 'string' && /^\d{2}-\d{2}-\d{2}$/.test(fecha)) {
                    const pts = fecha.split('-');
                    // Assume DD-MM-YY (Euro format with 2-digit year)
                    let year = parseInt(pts[2]);
                    if (year < 100) year += 2000;
                    fecha = `${year}-${pts[1]}-${pts[0]}`;
                }
                // ⚡ FIX: Handle DD-MM-YYYY format (e.g. "19-02-2026" -> "2026-02-19") from n8n
                if (typeof fecha === 'string' && /^\d{2}-\d{2}-\d{4}$/.test(fecha)) {
                    const pts = fecha.split('-');
                    fecha = `${pts[2]}-${pts[1]}-${pts[0]}`;
                }
                // Smart date correction: detect DD/MM vs MM/DD swap
                try {
                    const pd = new Date(fecha + 'T00:00:00');
                    const now = new Date(); now.setHours(0, 0, 0, 0);
                    const diff = (pd - now) / 86400000;
                    const pts = fecha.split('-');
                    if (pts.length === 3 && parseInt(pts[2]) <= 12 && (diff > 7 || diff < -365)) {
                        const sw = `${pts[0]}-${pts[2]}-${pts[1]}`;
                        const sd = new Date(sw + 'T00:00:00');
                        if (Math.abs((sd - now) / 86400000) < Math.abs(diff)) {
                            log('info', 'Auto-corrected date DD/MM swap', { original: fecha, corrected: sw });
                            fecha = sw;
                        }
                    }
                } catch (e) { /* keep original */ }


                placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6})`);
                values.push(batchId, compra.ingrediente, ingredienteId, precio, cantidad, fecha, req.restauranteId);
                paramIdx += 7;
                resultados.recibidos++;
            }

            if (placeholders.length > 0) {
                await pool.query(
                    `INSERT INTO compras_pendientes (batch_id, ingrediente_nombre, ingrediente_id, precio, cantidad, fecha, restaurante_id)
                 VALUES ${placeholders.join(', ')}`,
                    values
                );
            }

            log('info', 'Compras pendientes recibidas', { batchId, items: resultados.recibidos });
            res.json(resultados);
        } catch (err) {
            log('error', 'Error recibiendo compras pendientes', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // GET: Listar compras pendientes
    router.get('/purchases/pending', authMiddleware, async (req, res) => {
        try {
            const { estado } = req.query;
            let query = `
            SELECT cp.*, i.nombre as ingrediente_nombre_db, i.unidad
            FROM compras_pendientes cp
            LEFT JOIN ingredientes i ON cp.ingrediente_id = i.id
            WHERE cp.restaurante_id = $1`;
            const params = [req.restauranteId];

            if (estado) {
                query += ' AND cp.estado = $2';
                params.push(estado);
            } else {
                query += " AND cp.estado = 'pendiente'";
            }

            query += ' ORDER BY cp.created_at DESC, cp.batch_id, cp.ingrediente_nombre';

            const result = await pool.query(query, params);
            res.json(result.rows);
        } catch (err) {
            log('error', 'Error listando compras pendientes', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // POST: Aprobar un item pendiente → insertar en precios_compra_diarios + actualizar stock
    router.post('/purchases/pending/:id/approve', authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Obtener el item pendiente
            const itemResult = await client.query(
                "SELECT * FROM compras_pendientes WHERE id = $1 AND restaurante_id = $2 AND estado = 'pendiente' FOR UPDATE",
                [req.params.id, req.restauranteId]
            );

            if (itemResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Item no encontrado o ya procesado' });
            }

            const item = itemResult.rows[0];

            if (!item.ingrediente_id) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'El item no tiene ingrediente asignado. Edítalo primero.' });
            }

            const total = item.precio * item.cantidad;

            // Insertar en precios_compra_diarios
            await upsertCompraDiaria(client, {
                ingredienteId: item.ingrediente_id,
                fecha: item.fecha,
                precioUnitario: item.precio,
                cantidad: item.cantidad,
                total,
                restauranteId: req.restauranteId
            });

            // Actualizar stock — la cantidad de la foto ya viene en unidad base (botellas, kg, etc.)
            // NO multiplicar por cantidad_por_formato (eso es solo para pedidos manuales por formato/caja)
            await client.query(
                'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE',
                [item.ingrediente_id, req.restauranteId]
            );

            await client.query(
                'UPDATE ingredientes SET stock_actual = stock_actual + $1, ultima_actualizacion_stock = NOW() WHERE id = $2 AND restaurante_id = $3',
                [item.cantidad, item.ingrediente_id, req.restauranteId]
            );

            // Marcar como aprobado
            await client.query(
                "UPDATE compras_pendientes SET estado = 'aprobado', aprobado_at = NOW() WHERE id = $1 AND restaurante_id = $2",
                [req.params.id, req.restauranteId]
            );

            await client.query('COMMIT');
            log('info', 'Compra pendiente aprobada', { id: req.params.id, ingredienteId: item.ingrediente_id });
            res.json({ success: true, message: 'Compra aprobada y registrada' });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error aprobando compra pendiente', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    // POST: Aprobar todos los items de un batch
    router.post('/purchases/pending/approve-batch', authMiddleware, requireAdmin, async (req, res) => {
        const client = await pool.connect();
        try {
            const { batchId } = req.body;
            if (!batchId) {
                return res.status(400).json({ error: 'batchId requerido' });
            }

            await client.query('BEGIN');

            // Obtener items pendientes del batch
            const itemsResult = await client.query(
                "SELECT * FROM compras_pendientes WHERE batch_id = $1 AND restaurante_id = $2 AND estado = 'pendiente' FOR UPDATE",
                [batchId, req.restauranteId]
            );

            if (itemsResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'No hay items pendientes en este batch' });
            }

            const resultados = { aprobados: 0, omitidos: 0 };

            for (const item of itemsResult.rows) {
                if (!item.ingrediente_id) {
                    resultados.omitidos++;
                    continue;
                }

                const total = item.precio * item.cantidad;

                // Insertar en precios_compra_diarios
                await upsertCompraDiaria(client, {
                    ingredienteId: item.ingrediente_id,
                    fecha: item.fecha,
                    precioUnitario: item.precio,
                    cantidad: item.cantidad,
                    total,
                    restauranteId: req.restauranteId
                });

                // Actualizar stock — la cantidad de la foto ya viene en unidad base (botellas, kg, etc.)
                // NO multiplicar por cantidad_por_formato (eso es solo para pedidos manuales por formato/caja)
                await client.query(
                    'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE',
                    [item.ingrediente_id, req.restauranteId]
                );

                await client.query(
                    'UPDATE ingredientes SET stock_actual = stock_actual + $1, ultima_actualizacion_stock = NOW() WHERE id = $2 AND restaurante_id = $3',
                    [item.cantidad, item.ingrediente_id, req.restauranteId]
                );

                // Marcar como aprobado
                await client.query(
                    "UPDATE compras_pendientes SET estado = 'aprobado', aprobado_at = NOW() WHERE id = $1 AND restaurante_id = $2",
                    [item.id, req.restauranteId]
                );

                resultados.aprobados++;
            }

            await client.query('COMMIT');
            log('info', 'Batch de compras aprobado', { batchId, aprobados: resultados.aprobados, omitidos: resultados.omitidos });
            res.json(resultados);
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error aprobando batch', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    // PUT: Editar un item pendiente (cambiar ingrediente_id, precio, cantidad)
    router.put('/purchases/pending/:id', authMiddleware, async (req, res) => {
        try {
            const { ingrediente_id, precio, cantidad, fecha } = req.body;

            // Verificar que el item existe y es pendiente
            const existing = await pool.query(
                "SELECT id FROM compras_pendientes WHERE id = $1 AND restaurante_id = $2 AND estado = 'pendiente'",
                [req.params.id, req.restauranteId]
            );

            if (existing.rows.length === 0) {
                return res.status(404).json({ error: 'Item no encontrado o ya procesado' });
            }

            // Construir update dinámico
            const updates = [];
            const values = [];
            let paramIdx = 1;

            if (ingrediente_id !== undefined) {
                // Validar que el ingrediente existe y pertenece al restaurante
                const ingCheck = await pool.query(
                    'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2',
                    [ingrediente_id, req.restauranteId]
                );
                if (ingCheck.rows.length === 0) {
                    return res.status(400).json({ error: 'Ingrediente no válido' });
                }
                updates.push(`ingrediente_id = $${paramIdx++}`);
                values.push(ingrediente_id);
            }
            if (precio !== undefined) {
                updates.push(`precio = $${paramIdx++}`);
                values.push(Math.abs(parseFloat(precio)));
            }
            if (cantidad !== undefined) {
                updates.push(`cantidad = $${paramIdx++}`);
                values.push(Math.abs(parseFloat(cantidad)));
            }
            if (fecha !== undefined) {
                updates.push(`fecha = $${paramIdx++}`);
                values.push(fecha);
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No se proporcionó nada para actualizar' });
            }

            values.push(req.params.id, req.restauranteId);
            await pool.query(
                `UPDATE compras_pendientes SET ${updates.join(', ')} WHERE id = $${paramIdx} AND restaurante_id = $${paramIdx + 1}`,
                values
            );

            res.json({ success: true, message: 'Item actualizado' });
        } catch (err) {
            log('error', 'Error editando compra pendiente', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // DELETE: Rechazar/eliminar un item pendiente
    router.delete('/purchases/pending/:id', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(
                "UPDATE compras_pendientes SET estado = 'rechazado' WHERE id = $1 AND restaurante_id = $2 AND estado = 'pendiente' RETURNING id",
                [req.params.id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Item no encontrado o ya procesado' });
            }

            res.json({ success: true, message: 'Item rechazado' });
        } catch (err) {
            log('error', 'Error rechazando compra pendiente', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // Registrar compras diarias (bulk - para n8n, LEGACY — mantenido por compatibilidad)
    router.post('/daily/purchases/bulk', authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            const { compras } = req.body;

            if (!Array.isArray(compras)) {
                return res.status(400).json({
                    error: 'Formato inválido: se esperaba un array "compras"',
                    ejemplo: { compras: [{ ingrediente: "Pulpo", precio: 26, cantidad: 10, fecha: "2025-12-17" }] }
                });
            }

            await client.query('BEGIN');

            const resultados = { procesados: 0, fallidos: 0, duplicados: 0, errores: [] };

            // Función para normalizar nombres (quitar acentos, mayúsculas, espacios extra)
            const normalizar = (str) => {
                return (str || '')
                    .toLowerCase()
                    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos
                    .replace(/[^a-z0-9\s]/g, '') // quitar caracteres especiales
                    .replace(/\s+/g, ' ') // espacios múltiples a uno
                    .trim();
            };

            // Obtener todos los ingredientes para búsqueda flexible (incluyendo cantidad_por_formato)
            const ingredientesResult = await client.query(
                'SELECT id, nombre, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1',
                [req.restauranteId]
            );
            const ingredientesMap = new Map();
            ingredientesResult.rows.forEach(i => {
                ingredientesMap.set(normalizar(i.nombre), { id: i.id, cantidadPorFormato: parseFloat(i.cantidad_por_formato) || 0 });
            });

            // Obtener todos los alias para búsqueda
            const aliasResult = await client.query(
                `SELECT a.alias, a.ingrediente_id, i.cantidad_por_formato 
             FROM ingredientes_alias a 
             JOIN ingredientes i ON a.ingrediente_id = i.id
             WHERE a.restaurante_id = $1`,
                [req.restauranteId]
            );
            const aliasMap = new Map();
            aliasResult.rows.forEach(a => {
                aliasMap.set(normalizar(a.alias), { id: a.ingrediente_id, cantidadPorFormato: parseFloat(a.cantidad_por_formato) || 0 });
            });

            for (const compra of compras) {
                const nombreNormalizado = normalizar(compra.ingrediente);
                let ingredienteData = ingredientesMap.get(nombreNormalizado);

                // Si no encuentra exacto, buscar coincidencia parcial
                if (!ingredienteData) {
                    for (const [nombreDB, data] of ingredientesMap) {
                        if (nombreDB.includes(nombreNormalizado) || nombreNormalizado.includes(nombreDB)) {
                            ingredienteData = data;
                            break;
                        }
                    }
                }

                // Si aún no encuentra, buscar en tabla de alias
                if (!ingredienteData) {
                    ingredienteData = aliasMap.get(nombreNormalizado);
                }

                // Si aún no encuentra, buscar alias con coincidencia parcial
                if (!ingredienteData) {
                    for (const [aliasNombre, data] of aliasMap) {
                        if (aliasNombre.includes(nombreNormalizado) || nombreNormalizado.includes(aliasNombre)) {
                            ingredienteData = data;
                            break;
                        }
                    }
                }

                if (!ingredienteData) {
                    resultados.fallidos++;
                    resultados.errores.push({ ingrediente: compra.ingrediente, error: 'Ingrediente no encontrado' });
                    continue;
                }

                const ingredienteId = ingredienteData.id;
                const cantidadPorFormato = ingredienteData.cantidadPorFormato;

                const precio = parseFloat(compra.precio) || 0;
                const cantidad = parseFloat(compra.cantidad) || 0;
                const total = precio * cantidad;
                const fecha = compra.fecha || new Date().toISOString().split('T')[0];

                // 🛡️ Deduplicación: si ya existe una compra de este ingrediente en esta fecha
                // (por ejemplo, desde un pedido manual), SKIP para no duplicar
                const existingPurchase = await client.query(
                    `SELECT id FROM precios_compra_diarios 
                 WHERE ingrediente_id = $1 AND fecha = $2 AND restaurante_id = $3
                 LIMIT 1`,
                    [ingredienteId, fecha, req.restauranteId]
                );

                if (existingPurchase.rows.length > 0) {
                    resultados.duplicados++;
                    continue;
                }

                // Insertar nueva compra (sin pedido_id = NULL → COALESCE default 0)
                await upsertCompraDiaria(client, {
                    ingredienteId,
                    fecha,
                    precioUnitario: precio,
                    cantidad, total,
                    restauranteId: req.restauranteId
                });

                // Solo actualizar stock, NO el precio (el precio solo se cambia manualmente)
                // Si tiene cantidad_por_formato, multiplicar: cantidad × cantidad_por_formato
                const stockASumar = cantidadPorFormato > 0 ? cantidad * cantidadPorFormato : cantidad;
                // ⚡ FIX Bug #8: Lock row before update to prevent race condition
                await client.query('SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE', [ingredienteId, req.restauranteId]);
                await client.query(
                    'UPDATE ingredientes SET stock_actual = stock_actual + $1, ultima_actualizacion_stock = NOW() WHERE id = $2 AND restaurante_id = $3',
                    [stockASumar, ingredienteId, req.restauranteId]
                );

                resultados.procesados++;
            }

            await client.query('COMMIT');
            log('info', 'Compras diarias importadas', { procesados: resultados.procesados, fallidos: resultados.fallidos, duplicados: resultados.duplicados });
            res.json(resultados);
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error importando compras diarias', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    // Obtener resumen diario de ventas
    router.get('/daily/sales', authMiddleware, async (req, res) => {
        try {
            const { fecha, mes, ano } = req.query;
            let query = `
            SELECT v.*, r.nombre as receta_nombre, r.categoria
            FROM ventas_diarias_resumen v
            LEFT JOIN recetas r ON v.receta_id = r.id
            WHERE v.restaurante_id = $1
        `;
            let params = [req.restauranteId];

            if (fecha) {
                query += ' AND v.fecha = $2';
                params.push(fecha);
            } else if (mes && ano) {
                const m = parseInt(mes), y = parseInt(ano);
                const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
                const nm = m === 12 ? 1 : m + 1, ny = m === 12 ? y + 1 : y;
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

    // Resumen mensual completo (formato tipo Excel)
    router.get('/monthly/summary', authMiddleware, async (req, res) => {
        try {
            const { mes, ano } = req.query;
            const mesActual = parseInt(mes) || new Date().getMonth() + 1;
            const anoActual = parseInt(ano) || new Date().getFullYear();

            // Obtener días del mes con compras (incluye proveedor con fallback a proveedor principal del ingrediente)
            const comprasDiarias = await pool.query(`
            SELECT 
                p.fecha,
                i.id as ingrediente_id,
                i.nombre as ingrediente,
                p.precio_unitario,
                p.cantidad_comprada,
                p.total_compra,
                COALESCE(pr.nombre, pr_fallback.nombre) as proveedor_nombre,
                COALESCE(p.proveedor_id, ip.proveedor_id) as proveedor_id
            FROM precios_compra_diarios p
            JOIN ingredientes i ON p.ingrediente_id = i.id
            LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
            LEFT JOIN ingredientes_proveedores ip ON ip.ingrediente_id = p.ingrediente_id AND ip.es_proveedor_principal = true
            LEFT JOIN proveedores pr_fallback ON ip.proveedor_id = pr_fallback.id AND p.proveedor_id IS NULL
            WHERE p.restaurante_id = $1
              AND p.fecha >= $2 AND p.fecha < $3
            ORDER BY p.fecha, i.nombre
        `, [req.restauranteId, `${anoActual}-${String(mesActual).padStart(2, '0')}-01`, `${mesActual === 12 ? anoActual + 1 : anoActual}-${String(mesActual === 12 ? 1 : mesActual + 1).padStart(2, '0')}-01`]);

            // Obtener ventas directamente de la tabla ventas (agrupadas por día y receta)
            const ventasDiarias = await pool.query(`
            SELECT 
                DATE(v.fecha) as fecha,
                r.id as receta_id,
                r.nombre as receta,
                r.ingredientes as receta_ingredientes,
                SUM(v.cantidad) as cantidad_vendida,
                AVG(v.precio_unitario) as precio_venta_unitario,
                SUM(v.total) as total_ingresos
            FROM ventas v
            JOIN recetas r ON v.receta_id = r.id
            WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
              AND v.fecha >= $2 AND v.fecha < $3
            GROUP BY DATE(v.fecha), r.id, r.nombre, r.ingredientes
            ORDER BY DATE(v.fecha), r.nombre
        `, [req.restauranteId, `${anoActual}-${String(mesActual).padStart(2, '0')}-01`, `${mesActual === 12 ? anoActual + 1 : anoActual}-${String(mesActual === 12 ? 1 : mesActual + 1).padStart(2, '0')}-01`]);

            // Obtener precios de todos los ingredientes para calcular costes
            // CORREGIDO: Incluir cantidad_por_formato para calcular precio UNITARIO
            const ingredientesPrecios = await pool.query(
                'SELECT id, precio, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1',
                [req.restauranteId]
            );
            const preciosMap = {};
            ingredientesPrecios.rows.forEach(ing => {
                const precio = parseFloat(ing.precio) || 0;
                const cantidadPorFormato = parseFloat(ing.cantidad_por_formato) || 1;
                // Precio unitario = precio del formato / cantidad en el formato
                preciosMap[ing.id] = precio / cantidadPorFormato;
            });

            // Función para calcular coste de una receta
            const calcularCosteReceta = (ingredientesReceta) => {
                if (!ingredientesReceta || !Array.isArray(ingredientesReceta)) return 0;
                return ingredientesReceta.reduce((sum, item) => {
                    const precio = preciosMap[item.ingredienteId] || 0;
                    const cantidad = parseFloat(item.cantidad) || 0;
                    return sum + (precio * cantidad);
                }, 0);
            };

            // Procesar datos en formato tipo Excel
            const ingredientesData = {};
            const recetasData = {};
            const diasSet = new Set();

            // Procesar compras
            comprasDiarias.rows.forEach(row => {
                const fechaStr = row.fecha.toISOString().split('T')[0];
                diasSet.add(fechaStr);

                if (!ingredientesData[row.ingrediente]) {
                    ingredientesData[row.ingrediente] = { id: row.ingrediente_id, dias: {}, total: 0, totalCantidad: 0 };
                }

                if (!ingredientesData[row.ingrediente].dias[fechaStr]) {
                    ingredientesData[row.ingrediente].dias[fechaStr] = {
                        precio: parseFloat(row.precio_unitario),
                        cantidad: parseFloat(row.cantidad_comprada),
                        total: parseFloat(row.total_compra)
                    };
                } else {
                    // ⚡ FIX: Acumular cantidades de múltiples pedidos del mismo día
                    const existing = ingredientesData[row.ingrediente].dias[fechaStr];
                    existing.cantidad += parseFloat(row.cantidad_comprada);
                    existing.total += parseFloat(row.total_compra);
                    // Precio unitario ponderado: total / cantidad
                    existing.precio = existing.cantidad > 0 ? existing.total / existing.cantidad : existing.precio;
                }
                ingredientesData[row.ingrediente].total += parseFloat(row.total_compra);
                ingredientesData[row.ingrediente].totalCantidad += parseFloat(row.cantidad_comprada);
            });

            // Agrupar compras por proveedor
            const proveedoresData = {};
            comprasDiarias.rows.forEach(row => {
                const fechaStr = row.fecha.toISOString().split('T')[0];
                const provNombre = row.proveedor_nombre || 'Sin proveedor';

                if (!proveedoresData[provNombre]) {
                    proveedoresData[provNombre] = { id: row.proveedor_id, dias: {}, total: 0 };
                }

                if (!proveedoresData[provNombre].dias[fechaStr]) {
                    proveedoresData[provNombre].dias[fechaStr] = 0;
                }
                proveedoresData[provNombre].dias[fechaStr] += parseFloat(row.total_compra);
                proveedoresData[provNombre].total += parseFloat(row.total_compra);
            });

            // Procesar ventas CON CÁLCULO DE COSTES
            ventasDiarias.rows.forEach(row => {
                const fechaStr = row.fecha.toISOString().split('T')[0];
                diasSet.add(fechaStr);

                const cantidadVendida = parseInt(row.cantidad_vendida);
                const totalIngresos = parseFloat(row.total_ingresos);

                // Calcular coste real desde ingredientes de la receta
                const costePorUnidad = calcularCosteReceta(row.receta_ingredientes);
                const costeTotal = costePorUnidad * cantidadVendida;
                const beneficio = totalIngresos - costeTotal;

                if (!recetasData[row.receta]) {
                    recetasData[row.receta] = { id: row.receta_id, dias: {}, totalVendidas: 0, totalIngresos: 0, totalCoste: 0, totalBeneficio: 0 };
                }

                recetasData[row.receta].dias[fechaStr] = {
                    vendidas: cantidadVendida,
                    precioVenta: parseFloat(row.precio_venta_unitario),
                    coste: costeTotal,
                    ingresos: totalIngresos,
                    beneficio: beneficio
                };
                recetasData[row.receta].totalVendidas += cantidadVendida;
                recetasData[row.receta].totalIngresos += totalIngresos;
                recetasData[row.receta].totalCoste += costeTotal;
                recetasData[row.receta].totalBeneficio += beneficio;
            });

            // Ordenar días
            const dias = Array.from(diasSet).sort();

            // Calcular totales generales
            const totalesCompras = Object.values(ingredientesData).reduce((sum, i) => sum + i.total, 0);
            const totalesVentas = Object.values(recetasData).reduce((sum, r) => sum + r.totalIngresos, 0);
            const totalesCostes = Object.values(recetasData).reduce((sum, r) => sum + r.totalCoste, 0);
            const totalesBeneficio = Object.values(recetasData).reduce((sum, r) => sum + r.totalBeneficio, 0);

            res.json({
                mes: mesActual,
                ano: anoActual,
                dias,
                compras: {
                    ingredientes: ingredientesData,
                    porProveedor: proveedoresData,
                    total: totalesCompras
                },
                ventas: {
                    recetas: recetasData,
                    totalIngresos: totalesVentas,
                    totalCostes: totalesCostes,
                    beneficioBruto: totalesBeneficio
                },
                resumen: {
                    margenBruto: totalesVentas > 0 ? ((totalesBeneficio / totalesVentas) * 100).toFixed(1) : 0,
                    foodCost: totalesVentas > 0 ? ((totalesCostes / totalesVentas) * 100).toFixed(1) : 0
                }
            });
        } catch (err) {
            log('error', 'Error resumen mensual', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });


    return router;
};
