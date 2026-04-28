/**
 * ingredients Routes — Extracted from server.js
 * Ingredients CRUD, match, stock adjustment, toggle, ingredient-supplier associations
 */
const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { validatePrecio, validateCantidad, sanitizeString, validateRequired, validateId } = require('../utils/validators');
const { logChange } = require('../utils/auditLog');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== INGREDIENTES ==========
    router.get('/ingredients', authMiddleware, async (req, res) => {
        try {
            const { include_inactive } = req.query;
            // Por defecto solo devuelve activos y no eliminados
            let query = 'SELECT * FROM ingredientes WHERE restaurante_id = $1 AND deleted_at IS NULL';
            if (include_inactive !== 'true') {
                query += ' AND (activo IS NULL OR activo = TRUE)';
            }
            query += ' ORDER BY activo DESC NULLS FIRST, id';

            const result = await pool.query(query, [req.restauranteId]);
            res.json(result.rows || []);
        } catch (err) {
            log('error', 'Error obteniendo ingredientes', { error: err.message });
            res.status(500).json({ error: 'Error interno', data: [] });
        }
    });

    // ============================================
    // MATCH INGREDIENT BY NAME (with alias support)
    // POST /api/ingredients/match
    // Busca ingrediente por nombre exacto, luego por alias
    // ============================================
    router.post('/ingredients/match', authMiddleware, async (req, res) => {
        try {
            const { nombre } = req.body;

            if (!nombre || typeof nombre !== 'string') {
                return res.status(400).json({
                    found: false,
                    error: 'Se requiere el campo nombre'
                });
            }

            const nombreLimpio = nombre.trim();

            // 1. Buscar por nombre exacto (case insensitive)
            let result = await pool.query(`
            SELECT id, nombre, unidad, precio, cantidad_por_formato, formato_compra, stock_actual
            FROM ingredientes
            WHERE restaurante_id = $1
              AND LOWER(nombre) = LOWER($2)
              AND (activo IS NULL OR activo = TRUE)
              AND deleted_at IS NULL
            LIMIT 1
        `, [req.restauranteId, nombreLimpio]);

            if (result.rows.length > 0) {
                const ing = result.rows[0];
                return res.json({
                    found: true,
                    match_type: 'exact',
                    ingrediente: {
                        id: ing.id,
                        nombre: ing.nombre,
                        unidad: ing.unidad,
                        precio: parseFloat(ing.precio) || 0,
                        cantidad_por_formato: parseFloat(ing.cantidad_por_formato) || null,
                        formato_compra: ing.formato_compra,
                        stock_actual: parseFloat(ing.stock_actual) || 0
                    }
                });
            }

            // 2. Buscar en tabla de alias
            result = await pool.query(`
            SELECT i.id, i.nombre, i.unidad, i.precio, i.cantidad_por_formato, i.formato_compra, i.stock_actual, a.alias
            FROM ingredientes_alias a
            JOIN ingredientes i ON a.ingrediente_id = i.id
            WHERE a.restaurante_id = $1
              AND LOWER(a.alias) = LOWER($2)
              AND (i.activo IS NULL OR i.activo = TRUE)
              AND i.deleted_at IS NULL
            LIMIT 1
        `, [req.restauranteId, nombreLimpio]);

            if (result.rows.length > 0) {
                const ing = result.rows[0];
                return res.json({
                    found: true,
                    match_type: 'alias',
                    alias_used: ing.alias,
                    ingrediente: {
                        id: ing.id,
                        nombre: ing.nombre,
                        unidad: ing.unidad,
                        precio: parseFloat(ing.precio) || 0,
                        cantidad_por_formato: parseFloat(ing.cantidad_por_formato) || null,
                        formato_compra: ing.formato_compra,
                        stock_actual: parseFloat(ing.stock_actual) || 0
                    }
                });
            }

            // 3. Buscar por coincidencia parcial (LIKE)
            result = await pool.query(`
            SELECT id, nombre, unidad, precio, cantidad_por_formato, formato_compra, stock_actual
            FROM ingredientes
            WHERE restaurante_id = $1
              AND LOWER(nombre) LIKE LOWER($2)
              AND (activo IS NULL OR activo = TRUE)
              AND deleted_at IS NULL
            ORDER BY LENGTH(nombre) ASC
            LIMIT 1
        `, [req.restauranteId, `%${nombreLimpio.replace(/[%_]/g, '\\$&')}%`]);

            if (result.rows.length > 0) {
                const ing = result.rows[0];
                return res.json({
                    found: true,
                    match_type: 'partial',
                    ingrediente: {
                        id: ing.id,
                        nombre: ing.nombre,
                        unidad: ing.unidad,
                        precio: parseFloat(ing.precio) || 0,
                        cantidad_por_formato: parseFloat(ing.cantidad_por_formato) || null,
                        formato_compra: ing.formato_compra,
                        stock_actual: parseFloat(ing.stock_actual) || 0
                    }
                });
            }

            // No encontrado
            return res.json({
                found: false,
                searched_name: nombreLimpio,
                message: 'Ingrediente no encontrado. Considere añadirlo o crear un alias.'
            });

        } catch (err) {
            log('error', 'Error en match ingrediente', { error: err.message });
            res.status(500).json({ found: false, error: 'Error interno' });
        }
    });

    router.post('/ingredients', authMiddleware, async (req, res) => {
        try {
            const { nombre, proveedorId, proveedor_id, precio, unidad, stockActual, stock_actual, stockMinimo, stock_minimo, familia, formato_compra, cantidad_por_formato, rendimiento } = req.body;

            // 🔒 Validar nombre requerido
            const nombreCheck = validateRequired(nombre, 'Nombre');
            if (!nombreCheck.valid) {
                return res.status(400).json({ error: nombreCheck.error });
            }

            // Validación numérica segura (previene NaN, valores negativos)
            const finalPrecio = validatePrecio(precio);
            const finalStockActual = validateCantidad(stockActual ?? stock_actual);
            const finalStockMinimo = validateCantidad(stockMinimo ?? stock_minimo);
            const finalProveedorId = proveedorId ?? proveedor_id ?? null;
            const finalFamilia = sanitizeString(familia, 50) || 'alimento';
            const finalFormatoCompra = sanitizeString(formato_compra, 50) || null;
            const finalCantidadPorFormato = cantidad_por_formato ? validateCantidad(cantidad_por_formato) : null;
            // 🔒 Rendimiento válido entre 1-100 (%). Defensa en profundidad: el frontend ya
            // clampa en el input, pero el backend debe rechazar datos fuera de rango
            // que pudieran entrar vía API directa.
            const rendimientoRaw = parseFloat(rendimiento);
            const finalRendimiento = Number.isFinite(rendimientoRaw) && rendimientoRaw > 0
                ? Math.min(100, Math.max(1, rendimientoRaw))
                : 100;

            const result = await pool.query(
                'INSERT INTO ingredientes (nombre, proveedor_id, precio, unidad, stock_actual, stock_minimo, familia, restaurante_id, formato_compra, cantidad_por_formato, rendimiento) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *',
                [nombreCheck.value, finalProveedorId, finalPrecio, sanitizeString(unidad, 20) || 'kg', finalStockActual, finalStockMinimo, finalFamilia, req.restauranteId, finalFormatoCompra, finalCantidadPorFormato, finalRendimiento]
            );
            res.status(201).json(result.rows[0]);
        } catch (err) {
            log('error', 'Error creando ingrediente', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.put('/ingredients/:id', authMiddleware, async (req, res) => {
        try {
            const idCheck = validateId(req.params.id);
            if (!idCheck.valid) {
                return res.status(400).json({ error: idCheck.error });
            }
            const id = idCheck.value;
            const body = req.body;

            // 🔒 FIX CRÍTICO: Primero obtener valores ACTUALES del ingrediente
            // Esto previene sobrescribir campos con valores por defecto cuando no vienen en el request
            const existingResult = await pool.query(
                'SELECT * FROM ingredientes WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL',
                [id, req.restauranteId]
            );

            if (existingResult.rows.length === 0) {
                return res.status(404).json({ error: 'Ingrediente no encontrado' });
            }

            const existing = existingResult.rows[0];

            // 🔒 Merge: Solo actualizar campos que vengan EXPLÍCITAMENTE en el request
            // Si un campo no viene o es undefined, mantener el valor existente
            const finalNombre = body.nombre !== undefined ? (sanitizeString(body.nombre, 255) || existing.nombre) : existing.nombre;
            const finalProveedorId = body.proveedorId !== undefined ? body.proveedorId :
                (body.proveedor_id !== undefined ? body.proveedor_id : existing.proveedor_id);
            const finalPrecio = body.precio !== undefined ? validatePrecio(body.precio) : parseFloat(existing.precio) || 0;
            const finalUnidad = body.unidad !== undefined ? body.unidad : existing.unidad;
            // 🔒 FIX CRÍTICO: Priorizar stock_actual (snake_case del backend) sobre stockActual (camelCase legacy)
            // Problema anterior: body.stockActual ?? body.stock_actual → si stockActual=0, usaba 0 aunque stock_actual=5
            const finalStockActual = (body.stock_actual !== undefined)
                ? validateCantidad(body.stock_actual)
                : (body.stockActual !== undefined)
                    ? validateCantidad(body.stockActual)
                    : parseFloat(existing.stock_actual) || 0;

            const finalStockMinimo = (body.stock_minimo !== undefined)
                ? validateCantidad(body.stock_minimo)
                : (body.stockMinimo !== undefined)
                    ? validateCantidad(body.stockMinimo)
                    : parseFloat(existing.stock_minimo) || 0;
            const finalFamilia = body.familia !== undefined ? body.familia : (existing.familia || 'alimento');
            const finalFormatoCompra = body.formato_compra !== undefined ? body.formato_compra : existing.formato_compra;
            const finalCantidadPorFormato = body.cantidad_por_formato !== undefined
                ? (body.cantidad_por_formato ? validateCantidad(body.cantidad_por_formato) : null)
                : existing.cantidad_por_formato;
            // 🔒 Rendimiento 1-100 (clamp) tanto si viene en el body como del valor existente.
            const clampRendimiento = (v) => {
                const n = parseFloat(v);
                return Number.isFinite(n) && n > 0 ? Math.min(100, Math.max(1, n)) : 100;
            };
            const finalRendimiento = body.rendimiento !== undefined
                ? clampRendimiento(body.rendimiento)
                : clampRendimiento(existing.rendimiento);

            // Log para debug (remover en producción)
            log('info', 'Actualizando ingrediente con preservación de datos', {
                id,
                cambios: Object.keys(body).filter(k => body[k] !== undefined),
                cantidadPorFormato: { antes: existing.cantidad_por_formato, despues: finalCantidadPorFormato }
            });

            // 🔒 deleted_at IS NULL: evita resucitar un ingrediente soft-eliminado vía PUT
            const result = await pool.query(
                'UPDATE ingredientes SET nombre=$1, proveedor_id=$2, precio=$3, unidad=$4, stock_actual=$5, stock_minimo=$6, familia=$7, formato_compra=$10, cantidad_por_formato=$11, rendimiento=$12 WHERE id=$8 AND restaurante_id=$9 AND deleted_at IS NULL RETURNING *',
                [finalNombre, finalProveedorId, finalPrecio, finalUnidad, finalStockActual, finalStockMinimo, finalFamilia, id, req.restauranteId, finalFormatoCompra, finalCantidadPorFormato, finalRendimiento]
            );

            // ⚡ PROPAGACIÓN: Si cambió el rendimiento, actualizar TODAS las recetas que usan este ingrediente
            const oldRendimiento = parseInt(existing.rendimiento) || 100;
            if (finalRendimiento !== oldRendimiento) {
                try {
                    const recetasResult = await pool.query(
                        'SELECT id, ingredientes FROM recetas WHERE restaurante_id = $1 AND deleted_at IS NULL',
                        [req.restauranteId]
                    );

                    let recetasActualizadas = 0;
                    for (const receta of recetasResult.rows) {
                        const ingredientes = receta.ingredientes || [];
                        if (!Array.isArray(ingredientes)) continue;

                        let changed = false;
                        const updatedIngredientes = ingredientes.map(ing => {
                            const ingId = ing.ingredienteId || ing.ingrediente_id || ing.id;
                            if (ingId === id) {
                                changed = true;
                                return { ...ing, rendimiento: finalRendimiento };
                            }
                            return ing;
                        });

                        if (changed) {
                            await pool.query(
                                'UPDATE recetas SET ingredientes = $1 WHERE id = $2 AND restaurante_id = $3',
                                [JSON.stringify(updatedIngredientes), receta.id, req.restauranteId]
                            );
                            recetasActualizadas++;
                        }
                    }

                    if (recetasActualizadas > 0) {
                        log('info', 'Rendimiento propagado a recetas', {
                            ingredienteId: id,
                            de: oldRendimiento,
                            a: finalRendimiento,
                            recetasActualizadas
                        });
                    }
                } catch (propError) {
                    // No fallar la operación principal si la propagación falla
                    log('error', 'Error propagando rendimiento a recetas', { error: propError.message });
                }
            }

            // Audit trail: fire-and-forget. `existing` es la fila pre-UPDATE,
            // `result.rows[0]` es la fila tras el UPDATE.
            logChange(pool, {
                req,
                tabla: 'ingredientes',
                operacion: 'UPDATE',
                registroId: id,
                datosAntes: existing,
                datosDespues: result.rows[0] || null,
            });

            res.json(result.rows[0] || {});
        } catch (err) {
            log('error', 'Error actualizando ingrediente', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.delete('/ingredients/:id', authMiddleware, requireAdmin, async (req, res) => {
        try {
            const idCheck = validateId(req.params.id);
            if (!idCheck.valid) {
                return res.status(400).json({ error: idCheck.error });
            }
            const id = idCheck.value;

            // Snapshot antes del soft-delete para audit_log
            const beforeResult = await pool.query(
                'SELECT * FROM ingredientes WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL',
                [id, req.restauranteId]
            );
            if (beforeResult.rows.length === 0) {
                return res.status(404).json({ error: 'Ingrediente no encontrado o ya eliminado' });
            }
            const datosAntes = beforeResult.rows[0];

            // SOFT DELETE: marca como eliminado sin borrar datos
            const result = await pool.query(
                'UPDATE ingredientes SET deleted_at = CURRENT_TIMESTAMP WHERE id=$1 AND restaurante_id=$2 AND deleted_at IS NULL RETURNING id',
                [id, req.restauranteId]
            );

            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Ingrediente no encontrado o ya eliminado' });
            }

            log('info', 'Ingrediente soft deleted', { id });

            logChange(pool, {
                req,
                tabla: 'ingredientes',
                operacion: 'DELETE',
                registroId: id,
                datosAntes,
                datosDespues: null,
            });

            res.json({ message: 'Eliminado', id: result.rows[0].id });
        } catch (err) {
            log('error', 'Error eliminando ingrediente', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // 🔒 ATOMIC STOCK ADJUSTMENT - Evita problemas de read-modify-write
    // El frontend ya NO calcula stock nuevo, solo envía el delta (+X o -X)
    router.post('/ingredients/:id/adjust-stock', authMiddleware, async (req, res) => {
        try {
            const idCheck = validateId(req.params.id);
            if (!idCheck.valid) {
                return res.status(400).json({ error: idCheck.error });
            }
            const id = idCheck.value;
            const { delta, reason, min_zero = true } = req.body;

            // Validar delta
            if (delta === undefined || delta === null || isNaN(parseFloat(delta))) {
                return res.status(400).json({ error: 'Delta requerido (número positivo o negativo)' });
            }

            const deltaValue = parseFloat(delta);

            // 🛡️ Guardrail: rechazar delta absurdo. Protege contra errores de UX
            // o dobles clicks que envien ajustes de stock con cantidades erroneas.
            if (Math.abs(deltaValue) > 10000) {
                return res.status(400).json({
                    error: `Delta absurdo (${deltaValue}). Limite maximo en valor absoluto: 10000. Si realmente necesitas un ajuste mayor, haz varias operaciones o ejecuta SQL manual con BEGIN.`
                });
            }

            // SQL atómico: GREATEST(0, stock + delta) para evitar negativos
            const stockExpr = min_zero
                ? 'GREATEST(0, COALESCE(stock_actual, 0) + $1)'
                : 'COALESCE(stock_actual, 0) + $1';

            const result = await pool.query(
                `UPDATE ingredientes 
             SET stock_actual = ${stockExpr},
                 ultima_actualizacion_stock = NOW()
             WHERE id = $2 AND restaurante_id = $3 AND deleted_at IS NULL
             RETURNING id, nombre, stock_actual, precio, cantidad_por_formato`,
                [deltaValue, id, req.restauranteId]
            );

            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Ingrediente no encontrado' });
            }

            const updated = result.rows[0];
            log('info', 'Stock ajustado atómicamente', {
                id,
                delta: deltaValue,
                nuevoStock: updated.stock_actual,
                reason: reason || 'no especificado'
            });

            res.json({
                success: true,
                id: updated.id,
                nombre: updated.nombre,
                stock_actual: parseFloat(updated.stock_actual),
                delta: deltaValue,
                reason
            });
        } catch (err) {
            log('error', 'Error ajustando stock', { error: err.message, id: req.params.id });
            res.status(500).json({ error: 'Error interno ajustando stock' });
        }
    });

    // Bulk atomic stock adjustment - Para operaciones con múltiples ingredientes (recepción, producción)
    // ⚡ FIX W1: Wrapped in transaction — all adjustments succeed or none do
    router.post('/ingredients/bulk-adjust-stock', authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            const { adjustments, reason } = req.body;
            // adjustments: [{ id: 123, delta: 5.0 }, { id: 456, delta: -2.0 }]

            if (!Array.isArray(adjustments) || adjustments.length === 0) {
                return res.status(400).json({ error: 'Array de ajustes requerido' });
            }

            await client.query('BEGIN');

            const results = [];
            const errors = [];

            for (const adj of adjustments) {
                if (!adj.id || adj.delta === undefined || isNaN(parseFloat(adj.delta))) {
                    errors.push({ id: adj.id, error: 'ID o delta inválido' });
                    continue;
                }

                // 🛡️ Guardrail: rechazar ajustes absurdos. Evita que un doble
                // click humano (incidente 2026-04-22) infle miles de unidades.
                if (Math.abs(parseFloat(adj.delta)) > 10000) {
                    errors.push({
                        id: adj.id,
                        error: `Delta absurdo (${adj.delta}). Maximo en valor absoluto: 10000.`
                    });
                    continue;
                }

                try {
                    // FOR UPDATE lock to prevent race conditions
                    // 🔒 deleted_at IS NULL: no bloquear filas zombi (auditoria A1-A3).
                    await client.query(
                        'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL FOR UPDATE',
                        [adj.id, req.restauranteId]
                    );

                    const result = await client.query(
                        `UPDATE ingredientes
                     SET stock_actual = GREATEST(0, COALESCE(stock_actual, 0) + $1),
                         ultima_actualizacion_stock = NOW()
                     WHERE id = $2 AND restaurante_id = $3 AND deleted_at IS NULL
                     RETURNING id, nombre, stock_actual`,
                        [parseFloat(adj.delta), adj.id, req.restauranteId]
                    );

                    if (result.rowCount > 0) {
                        results.push({
                            id: result.rows[0].id,
                            nombre: result.rows[0].nombre,
                            stock_actual: parseFloat(result.rows[0].stock_actual),
                            delta: parseFloat(adj.delta)
                        });
                    } else {
                        errors.push({ id: adj.id, error: 'No encontrado' });
                    }
                } catch (itemErr) {
                    errors.push({ id: adj.id, error: itemErr.message });
                }
            }

            await client.query('COMMIT');

            log('info', 'Bulk stock adjustment (transactional)', {
                reason: reason || 'no especificado',
                exitosos: results.length,
                fallidos: errors.length
            });

            res.json({ success: errors.length === 0, results, errors, reason });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error en bulk adjust stock', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    // Toggle activo/inactivo ingrediente (en lugar de eliminar)
    router.patch('/ingredients/:id/toggle-active', authMiddleware, async (req, res) => {
        try {
            // 🔒 validateId: rechazar IDs no enteros con 400 en vez de 500 (auditoria A1-M10).
            const idCheck = validateId(req.params.id);
            if (!idCheck.valid) {
                return res.status(400).json({ error: idCheck.error });
            }
            const id = idCheck.value;
            const { activo } = req.body;

            const result = await pool.query(
                'UPDATE ingredientes SET activo = $1 WHERE id = $2 AND restaurante_id = $3 AND deleted_at IS NULL RETURNING *',
                [activo, id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Ingrediente no encontrado' });
            }

            log('info', `Ingrediente ${activo ? 'activado' : 'desactivado'}`, { id, nombre: result.rows[0].nombre });
            res.json(result.rows[0]);
        } catch (err) {
            log('error', 'Error toggle activo ingrediente', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== INGREDIENTES - PROVEEDORES MÚLTIPLES ==========

    // GET /api/ingredients-suppliers - Obtener TODOS los ingredientes_proveedores del restaurante
    router.get('/ingredients-suppliers', authMiddleware, async (req, res) => {
        try {
            // 🔒 i.deleted_at IS NULL: no devolver asociaciones de ingredientes
            //    soft-deleted (auditoria A1-A5).
            const result = await pool.query(`
            SELECT ip.id, ip.ingrediente_id, ip.proveedor_id, ip.precio,
                   ip.es_proveedor_principal, ip.created_at,
                   p.nombre as proveedor_nombre
            FROM ingredientes_proveedores ip
            JOIN proveedores p ON ip.proveedor_id = p.id
            JOIN ingredientes i ON ip.ingrediente_id = i.id
            WHERE i.restaurante_id = $1
              AND i.deleted_at IS NULL
              AND p.deleted_at IS NULL
            ORDER BY ip.ingrediente_id, ip.es_proveedor_principal DESC
        `, [req.restauranteId]);

            res.json(result.rows);
        } catch (err) {
            log('error', 'Error obteniendo ingredientes-proveedores', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // GET /api/ingredients/:id/suppliers - Obtener proveedores de un ingrediente
    router.get('/ingredients/:id/suppliers', authMiddleware, async (req, res) => {
        try {
            const { id } = req.params;

            // Verificar que el ingrediente pertenece al restaurante
            const checkIng = await pool.query(
                'SELECT id, nombre FROM ingredientes WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL',
                [id, req.restauranteId]
            );

            if (checkIng.rows.length === 0) {
                return res.status(404).json({ error: 'Ingrediente no encontrado' });
            }

            const result = await pool.query(`
            SELECT ip.id, ip.ingrediente_id, ip.proveedor_id, ip.precio,
                   ip.es_proveedor_principal, ip.created_at,
                   p.nombre as proveedor_nombre, p.contacto, p.telefono, p.email
            FROM ingredientes_proveedores ip
            JOIN proveedores p ON ip.proveedor_id = p.id
            WHERE ip.ingrediente_id = $1
              AND p.deleted_at IS NULL
            ORDER BY ip.es_proveedor_principal DESC, p.nombre ASC
        `, [id]);

            res.json(result.rows);
        } catch (err) {
            log('error', 'Error obteniendo proveedores de ingrediente', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // POST /api/ingredients/:id/suppliers - Asociar proveedor a ingrediente
    router.post('/ingredients/:id/suppliers', authMiddleware, async (req, res) => {
        try {
            const { id } = req.params;
            const { proveedor_id, precio, es_proveedor_principal } = req.body;

            if (!proveedor_id || precio === undefined) {
                return res.status(400).json({ error: 'proveedor_id y precio son requeridos' });
            }

            const precioNum = parseFloat(precio);
            if (isNaN(precioNum) || precioNum < 0) {
                return res.status(400).json({ error: 'Precio debe ser un número válido >= 0' });
            }

            // Verificar ingrediente
            const checkIng = await pool.query(
                'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL',
                [id, req.restauranteId]
            );
            if (checkIng.rows.length === 0) {
                return res.status(404).json({ error: 'Ingrediente no encontrado' });
            }

            // Verificar proveedor
            const checkProv = await pool.query(
                'SELECT id FROM proveedores WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL',
                [proveedor_id, req.restauranteId]
            );
            if (checkProv.rows.length === 0) {
                return res.status(404).json({ error: 'Proveedor no encontrado' });
            }

            // Si es principal, desmarcar otros
            // 🔒 Defensa en profundidad: filtrar por restaurante_id vía JOIN aunque
            //    `id` ya está validado más arriba (auditoria A1-A2).
            if (es_proveedor_principal) {
                await pool.query(
                    `UPDATE ingredientes_proveedores ip
                     SET es_proveedor_principal = FALSE
                     FROM ingredientes i
                     WHERE ip.ingrediente_id = $1
                       AND ip.ingrediente_id = i.id
                       AND i.restaurante_id = $2`,
                    [id, req.restauranteId]
                );
                // Actualizar también en tabla ingredientes para compatibilidad
                // ⚠️ PROTECCIÓN: NO sobrescribir precio del ingrediente
                await pool.query(
                    'UPDATE ingredientes SET proveedor_id = $1 WHERE id = $2 AND restaurante_id = $3 AND deleted_at IS NULL',
                    [proveedor_id, id, req.restauranteId]
                );
            }

            // UPSERT - insertar o actualizar si ya existe
            const result = await pool.query(`
            INSERT INTO ingredientes_proveedores (ingrediente_id, proveedor_id, precio, es_proveedor_principal)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (ingrediente_id, proveedor_id)
            DO UPDATE SET precio = $3, es_proveedor_principal = $4
            RETURNING *
        `, [id, proveedor_id, precioNum, es_proveedor_principal || false]);

            // ⚡ SYNC: Actualizar columna ingredientes del proveedor desde la tabla relacional
            await pool.query(`
            UPDATE proveedores SET ingredientes = (
                SELECT COALESCE(array_agg(ip.ingrediente_id), ARRAY[]::int[])
                FROM ingredientes_proveedores ip WHERE ip.proveedor_id = $1
            ) WHERE id = $1
        `, [proveedor_id]);

            log('info', 'Proveedor asociado a ingrediente', { ingrediente_id: id, proveedor_id, precio: precioNum });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            log('error', 'Error asociando proveedor a ingrediente', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // PUT /api/ingredients/:id/suppliers/:supplierId - Actualizar precio o principal
    router.put('/ingredients/:id/suppliers/:supplierId', authMiddleware, async (req, res) => {
        try {
            const { id, supplierId } = req.params;
            const { precio, es_proveedor_principal } = req.body;

            // Verificar que la asociación existe y que TANTO ingrediente COMO proveedor
            // pertenecen al tenant actual. Sin el JOIN con proveedores, un token de
            // tenant A podría modificar asociaciones usando proveedor_id de tenant B.
            const check = await pool.query(`
            SELECT ip.id FROM ingredientes_proveedores ip
            JOIN ingredientes i ON ip.ingrediente_id = i.id
            JOIN proveedores p ON ip.proveedor_id = p.id
            WHERE ip.ingrediente_id = $1 AND ip.proveedor_id = $2
              AND i.restaurante_id = $3 AND p.restaurante_id = $3
        `, [id, supplierId, req.restauranteId]);

            if (check.rows.length === 0) {
                return res.status(404).json({ error: 'Asociación no encontrada' });
            }

            // Si se marca como principal, desmarcar otros
            // 🔒 Defensa en profundidad: filtrar por restaurante_id (auditoria A1-A2).
            if (es_proveedor_principal) {
                await pool.query(
                    `UPDATE ingredientes_proveedores ip
                     SET es_proveedor_principal = FALSE
                     FROM ingredientes i
                     WHERE ip.ingrediente_id = $1
                       AND ip.ingrediente_id = i.id
                       AND i.restaurante_id = $2`,
                    [id, req.restauranteId]
                );
                // Actualizar tabla ingredientes para compatibilidad
                // ⚠️ PROTECCIÓN: NO sobrescribir precio del ingrediente
                await pool.query(
                    'UPDATE ingredientes SET proveedor_id = $1 WHERE id = $2 AND restaurante_id = $3 AND deleted_at IS NULL',
                    [supplierId, id, req.restauranteId]
                );
            }

            // Construir query dinámico
            const updates = [];
            const values = [];
            let paramCount = 1;

            if (precio !== undefined) {
                const precioNum = parseFloat(precio);
                if (isNaN(precioNum) || precioNum < 0) {
                    return res.status(400).json({ error: 'Precio debe ser un número válido >= 0' });
                }
                updates.push(`precio = $${paramCount++}`);
                values.push(precioNum);
            }

            if (es_proveedor_principal !== undefined) {
                updates.push(`es_proveedor_principal = $${paramCount++}`);
                values.push(es_proveedor_principal);
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'Nada que actualizar' });
            }

            values.push(id, supplierId);
            const result = await pool.query(`
            UPDATE ingredientes_proveedores 
            SET ${updates.join(', ')}
            WHERE ingrediente_id = $${paramCount++} AND proveedor_id = $${paramCount}
            RETURNING *
        `, values);

            log('info', 'Actualizado proveedor de ingrediente', { ingrediente_id: id, proveedor_id: supplierId });
            res.json(result.rows[0]);
        } catch (err) {
            log('error', 'Error actualizando proveedor de ingrediente', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // DELETE /api/ingredients/:id/suppliers/:supplierId - Eliminar asociación
    router.delete('/ingredients/:id/suppliers/:supplierId', authMiddleware, async (req, res) => {
        try {
            const { id, supplierId } = req.params;

            // Verificar que existe y que TANTO ingrediente COMO proveedor pertenecen
            // al tenant actual (validación cross-tenant estricta).
            const check = await pool.query(`
            SELECT ip.id FROM ingredientes_proveedores ip
            JOIN ingredientes i ON ip.ingrediente_id = i.id
            JOIN proveedores p ON ip.proveedor_id = p.id
            WHERE ip.ingrediente_id = $1 AND ip.proveedor_id = $2
              AND i.restaurante_id = $3 AND p.restaurante_id = $3
        `, [id, supplierId, req.restauranteId]);

            if (check.rows.length === 0) {
                return res.status(404).json({ error: 'Asociación no encontrada' });
            }

            await pool.query(
                'DELETE FROM ingredientes_proveedores WHERE ingrediente_id = $1 AND proveedor_id = $2',
                [id, supplierId]
            );

            // ⚡ SYNC: Actualizar columna ingredientes del proveedor desde la tabla relacional
            await pool.query(`
            UPDATE proveedores SET ingredientes = (
                SELECT COALESCE(array_agg(ip.ingrediente_id), ARRAY[]::int[])
                FROM ingredientes_proveedores ip WHERE ip.proveedor_id = $1
            ) WHERE id = $1
        `, [supplierId]);

            log('info', 'Eliminada asociación proveedor-ingrediente', { ingrediente_id: id, proveedor_id: supplierId });
            res.json({ success: true });
        } catch (err) {
            log('error', 'Error eliminando proveedor de ingrediente', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    return router;
};
