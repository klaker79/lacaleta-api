/**
 * consumos-internos Routes — consumo de un PLATO/BEBIDA de la carta sin venta.
 *
 * Casos de uso: comida del personal (un empleado se come un plato de la carta),
 * prueba de cocina (I+D de un plato) e invitación a un cliente.
 *
 * ⚠️ NO confundir con la "comida personal" de los PEDIDOS (`personal: true` en
 * `pedidos.ingredientes`): aquello es COMPRA DESVIADA (producto que se aparta al
 * comprarlo y que nunca entra al negocio → NO toca stock). Esto es lo contrario:
 * producto YA COMPRADO que sale del almacén → SÍ descuenta stock.
 *
 * El descuento reutiliza exactamente el motor de las ventas:
 *   expandRecipeToBase (subrecetas recursivas + rendimiento) →
 *   agregarDeduccionesOrdenadas (agrega duplicados y ORDENA POR id, anti-deadlock) →
 *   UPDATE ingredientes con FOR UPDATE previo.
 * Se guarda el snapshot de lo realmente descontado en `stock_deductions` (mismo
 * patrón que `ventas.stock_deductions`) para poder revertirlo al borrar.
 *
 * FASE 1: descuenta stock y registra el coste. NO está cableado al P&L todavía
 * (decisión consciente); el coste se expone aquí para consultarlo aparte.
 */
const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { validateId, validateCantidad, validateDate, validateEnum, sanitizeString } = require('../utils/validators');
const { expandRecipeToBase, loadYieldConfig, getRecipeCostBase, getBackendIngredientUnitPrice } = require('../utils/businessHelpers');
const { agregarDeduccionesOrdenadas, esDeadlock } = require('../utils/stockDeduction');
const { logChange } = require('../utils/auditLog');

// Tipos permitidos. Se validan en la ruta (la columna es VARCHAR sin CHECK, igual
// que `pedidos.estado`, para poder añadir tipos sin migración).
const TIPOS_VALIDOS = ['personal', 'prueba', 'invitacion'];

// Reintentos ante deadlock: la transacción hizo rollback completo, reintentar es seguro.
const MAX_INTENTOS = 3;

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== LISTAR ==========
    router.get('/consumos-internos', authMiddleware, async (req, res) => {
        try {
            const { desde, hasta } = req.query;
            const params = [req.restauranteId];
            let where = 'restaurante_id = $1 AND deleted_at IS NULL';

            if (desde) {
                const d = validateDate(desde);
                if (!d.valid) return res.status(400).json({ error: `desde: ${d.error}` });
                params.push(desde);
                where += ` AND fecha >= $${params.length}`;
            }
            if (hasta) {
                const h = validateDate(hasta);
                if (!h.valid) return res.status(400).json({ error: `hasta: ${h.error}` });
                params.push(hasta);
                where += ` AND fecha < $${params.length}`;
            }

            const { rows } = await pool.query(
                `SELECT id, receta_id, receta_nombre, variante_id, factor_variante, porciones,
                        tipo, coste, empleado_id, nota, fecha, created_at
                 FROM consumos_internos
                 WHERE ${where}
                 ORDER BY fecha DESC, id DESC`,
                params
            );

            const totalCoste = rows.reduce((s, r) => s + (parseFloat(r.coste) || 0), 0);
            res.json({
                consumos: rows,
                total_registros: rows.length,
                total_coste: Math.round(totalCoste * 100) / 100
            });
        } catch (err) {
            log('error', 'Error listando consumos internos', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== REGISTRAR (descuenta stock) ==========
    router.post('/consumos-internos', authMiddleware, async (req, res) => {
        const { recetaId, porciones, tipo, fecha, empleadoId, nota, varianteId } = req.body;

        const idCheck = validateId(recetaId);
        if (!idCheck.valid) return res.status(400).json({ error: `recetaId: ${idCheck.error}` });

        const porcionesValidadas = validateCantidad(porciones);
        if (porcionesValidadas === 0) {
            return res.status(400).json({ error: 'porciones debe ser un número positivo' });
        }

        const tipoCheck = validateEnum(tipo || 'personal', TIPOS_VALIDOS, 'tipo');
        if (!tipoCheck.valid) return res.status(400).json({ error: tipoCheck.error });

        // Fecha opcional: por defecto hoy. No se acepta futuro (no puedes haberte
        // comido mañana un plato); las fechas pasadas SÍ (apuntar lo de ayer).
        let fechaConsumo = new Date();
        if (fecha) {
            const f = validateDate(fecha, { allowFuture: false });
            if (!f.valid) return res.status(400).json({ error: `fecha: ${f.error}` });
            fechaConsumo = f.value;
        }

        let empleadoIdFinal = null;
        if (empleadoId) {
            const e = validateId(empleadoId);
            if (!e.valid) return res.status(400).json({ error: `empleadoId: ${e.error}` });
            empleadoIdFinal = e.value;
        }

        const notaLimpia = nota ? sanitizeString(nota, 500) : null;

        const client = await pool.connect();
        try {
            for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
                try {
                    await client.query('BEGIN');

                    // 1. Receta del tenant (y no borrada)
                    const recetaRes = await client.query(
                        'SELECT id, nombre, porciones, ingredientes FROM recetas WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL',
                        [idCheck.value, req.restauranteId]
                    );
                    if (recetaRes.rows.length === 0) {
                        await client.query('ROLLBACK');
                        return res.status(404).json({ error: 'Receta no encontrada' });
                    }
                    const receta = recetaRes.rows[0];

                    // 2. Variante opcional (ej. copa de vino = 0.2 botella). Si la receta
                    //    tiene variantes y no se envía ninguna, se asume la base (factor 1).
                    let factorVariante = 1;
                    let varianteIdFinal = null;
                    if (varianteId) {
                        const v = validateId(varianteId);
                        if (!v.valid) {
                            await client.query('ROLLBACK');
                            return res.status(400).json({ error: `varianteId: ${v.error}` });
                        }
                        const varRes = await client.query(
                            'SELECT id, factor FROM recetas_variantes WHERE id = $1 AND receta_id = $2 AND restaurante_id = $3',
                            [v.value, receta.id, req.restauranteId]
                        );
                        if (varRes.rows.length === 0) {
                            await client.query('ROLLBACK');
                            return res.status(400).json({ error: 'La variante no pertenece a esta receta' });
                        }
                        factorVariante = parseFloat(varRes.rows[0].factor) || 1;
                        varianteIdFinal = varRes.rows[0].id;
                    }

                    // 3. Expandir a ingredientes BASE (subrecetas + rendimiento del tenant)
                    const yieldCfg = await loadYieldConfig(client, req.restauranteId);
                    const baseIngs = await expandRecipeToBase(receta, client, req.restauranteId, yieldCfg);

                    // 4. Descontar stock en orden de id ascendente (anti-deadlock)
                    const deducciones = agregarDeduccionesOrdenadas(baseIngs, porcionesValidadas * factorVariante);
                    const stockDeductions = [];
                    for (const { ingredienteId: ingId, cantidad: cantidadADescontar } of deducciones) {
                        const lockRes = await client.query(
                            'SELECT id, stock_actual FROM ingredientes WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL FOR UPDATE',
                            [ingId, req.restauranteId]
                        );
                        if (lockRes.rows.length === 0) {
                            log('warn', 'Ingrediente base no encontrado en consumo interno', { recetaId: receta.id, ingId });
                            continue;
                        }
                        const stockAntes = parseFloat(lockRes.rows[0].stock_actual) || 0;
                        const updRes = await client.query(
                            'UPDATE ingredientes SET stock_actual = GREATEST(0, stock_actual - $1), ultima_actualizacion_stock = NOW() WHERE id = $2 AND restaurante_id = $3 RETURNING stock_actual',
                            [cantidadADescontar, ingId, req.restauranteId]
                        );
                        const stockDespues = parseFloat(updRes.rows[0]?.stock_actual) || 0;
                        stockDeductions.push({
                            ingredienteId: ingId,
                            real: stockAntes - stockDespues,
                            calculado: cantidadADescontar
                        });
                    }

                    // 5. Coste real del consumo (mismo cálculo que el food cost de una venta).
                    //    Se calcula en el BACKEND: nunca se acepta un coste del cliente.
                    const preciosRes = await client.query(
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
                        [req.restauranteId]
                    );
                    const preciosMap = new Map();
                    const rendimientoBaseMap = new Map();
                    preciosRes.rows.forEach(i => {
                        preciosMap.set(i.id, getBackendIngredientUnitPrice(i));
                        if (i.rendimiento) rendimientoBaseMap.set(i.id, parseFloat(i.rendimiento));
                    });
                    const todasRecetasRes = await client.query(
                        'SELECT id, porciones, ingredientes FROM recetas WHERE restaurante_id = $1 AND deleted_at IS NULL',
                        [req.restauranteId]
                    );
                    const recetasMap = new Map(todasRecetasRes.rows.map(r => [r.id, r]));

                    const porcionesReceta = Math.max(1, parseInt(receta.porciones) || 1);
                    const costeLote = getRecipeCostBase(receta, preciosMap, recetasMap, rendimientoBaseMap);
                    const coste = Math.round(((costeLote / porcionesReceta) * porcionesValidadas * factorVariante) * 100) / 100;

                    // 6. Registrar
                    const insertRes = await client.query(
                        `INSERT INTO consumos_internos
                         (restaurante_id, receta_id, receta_nombre, variante_id, factor_variante,
                          porciones, tipo, coste, empleado_id, nota, fecha, stock_deductions)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
                        [
                            req.restauranteId, receta.id, receta.nombre, varianteIdFinal, factorVariante,
                            porcionesValidadas, tipoCheck.value, coste, empleadoIdFinal, notaLimpia,
                            fechaConsumo.toISOString().split('T')[0],
                            stockDeductions.length > 0 ? JSON.stringify(stockDeductions) : null
                        ]
                    );

                    await client.query('COMMIT');

                    logChange(pool, {
                        req, tabla: 'consumos_internos', operacion: 'INSERT',
                        registroId: insertRes.rows[0].id,
                        datosAntes: null, datosDespues: insertRes.rows[0]
                    });

                    res.status(201).json(insertRes.rows[0]);
                    return;
                } catch (errTxn) {
                    await client.query('ROLLBACK');
                    if (esDeadlock(errTxn) && intento < MAX_INTENTOS) {
                        log('warn', 'Deadlock en consumo interno — reintentando', { intento, error: errTxn.message });
                        continue;
                    }
                    throw errTxn;
                }
            }
        } catch (err) {
            log('error', 'Error registrando consumo interno', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    // ========== BORRAR (revierte el stock descontado) ==========
    router.delete('/consumos-internos/:id', authMiddleware, requireAdmin, async (req, res) => {
        const idCheck = validateId(req.params.id);
        if (!idCheck.valid) return res.status(400).json({ error: idCheck.error });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const consumoRes = await client.query(
                'SELECT * FROM consumos_internos WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL FOR UPDATE',
                [idCheck.value, req.restauranteId]
            );
            if (consumoRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Consumo interno no encontrado' });
            }
            const consumo = consumoRes.rows[0];

            // Devolver al stock exactamente lo que se descontó (snapshot `real`).
            // En orden de id ascendente, igual que al descontar (anti-deadlock).
            const deducciones = Array.isArray(consumo.stock_deductions) ? consumo.stock_deductions : [];
            const ordenadas = [...deducciones].sort((a, b) => (a.ingredienteId || 0) - (b.ingredienteId || 0));
            for (const d of ordenadas) {
                const cantidad = parseFloat(d.real) || 0;
                if (!d.ingredienteId || cantidad <= 0) continue;
                await client.query(
                    'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL FOR UPDATE',
                    [d.ingredienteId, req.restauranteId]
                );
                await client.query(
                    `UPDATE ingredientes SET stock_actual = stock_actual + $1, ultima_actualizacion_stock = NOW()
                     WHERE id = $2 AND restaurante_id = $3 AND deleted_at IS NULL`,
                    [cantidad, d.ingredienteId, req.restauranteId]
                );
            }

            // Soft delete (historial)
            await client.query(
                'UPDATE consumos_internos SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND restaurante_id = $2',
                [idCheck.value, req.restauranteId]
            );

            await client.query('COMMIT');

            logChange(pool, {
                req, tabla: 'consumos_internos', operacion: 'DELETE',
                registroId: idCheck.value,
                datosAntes: consumo, datosDespues: null
            });

            res.json({ success: true, id: idCheck.value, stock_restaurado: ordenadas.length });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error borrando consumo interno', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    return router;
};
