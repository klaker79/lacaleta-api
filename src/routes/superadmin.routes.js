/**
 * Super Admin Routes — Platform management across all restaurants
 * All routes require authMiddleware + requireSuperAdmin
 */
const { Router } = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { authMiddleware, requireSuperAdmin } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { validateNumber, validateId, sanitizeString } = require('../utils/validators');
const APP_URL = process.env.APP_URL || 'https://app.mindloop.cloud';
const PLAN_MAX_USERS = { starter: 2, profesional: 5, premium: 999, trial: 5 };

module.exports = function (pool, config = {}) {
    const router = Router();
    const JWT_SECRET = config.JWT_SECRET || process.env.JWT_SECRET;

    // Apply auth + superadmin to all /superadmin routes
    // No authLimiter here — globalLimiter (2000/15min) is enough for admin panel
    router.use('/superadmin', authMiddleware, requireSuperAdmin);

    // ========== METRICS / KPIs ==========
    router.get('/superadmin/metrics', async (req, res) => {
        try {
            const [totalRes, planRes, activeRes, trialRes, usersRes, paidRes] = await Promise.all([
                pool.query('SELECT COUNT(*) as total FROM restaurantes'),
                pool.query('SELECT plan, plan_status, COUNT(*) as count FROM restaurantes GROUP BY plan, plan_status'),
                pool.query("SELECT COUNT(*) as total FROM restaurantes WHERE plan_status IN ('active', 'trialing')"),
                pool.query("SELECT COUNT(*) as total FROM restaurantes WHERE plan = 'trial' AND plan_status = 'trialing' AND trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'"),
                pool.query('SELECT COUNT(*) as total FROM usuarios'),
                pool.query("SELECT COUNT(*) as total FROM restaurantes WHERE plan_status = 'active' AND plan != 'trial'")
            ]);

            res.json({
                totalRestaurants: parseInt(totalRes.rows[0].total),
                byPlan: planRes.rows,
                activeSubscriptions: parseInt(activeRes.rows[0].total),
                trialsExpiringSoon: parseInt(trialRes.rows[0].total),
                totalUsers: parseInt(usersRes.rows[0].total),
                activePaidSubscriptions: parseInt(paidRes.rows[0].total)
            });
        } catch (err) {
            log('error', 'Error en superadmin metrics', { error: err.message });
            res.status(500).json({ error: 'Error obteniendo métricas' });
        }
    });

    // ========== LIST RESTAURANTS ==========
    router.get('/superadmin/restaurants', async (req, res) => {
        try {
            const { plan, status, search, limit, offset } = req.query;
            const conditions = [];
            const params = [];
            let paramIndex = 1;

            if (plan) {
                conditions.push(`r.plan = $${paramIndex++}`);
                params.push(plan);
            }
            if (status) {
                conditions.push(`r.plan_status = $${paramIndex++}`);
                params.push(status);
            }
            if (search) {
                conditions.push(`(r.nombre ILIKE $${paramIndex} OR r.email ILIKE $${paramIndex})`);
                params.push(`%${search}%`);
                paramIndex++;
            }

            const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
            const limitVal = validateNumber(limit, 50, 1, 200);
            const offsetVal = validateNumber(offset, 0, 0);

            const countParams = [...params];
            params.push(limitVal, offsetVal);

            const query = `
                SELECT r.*,
                    (SELECT COUNT(*) FROM usuarios u WHERE u.restaurante_id = r.id) as user_count
                FROM restaurantes r
                ${where}
                ORDER BY r.created_at DESC
                LIMIT $${paramIndex++} OFFSET $${paramIndex++}
            `;

            const countQuery = `SELECT COUNT(*) as total FROM restaurantes r ${where}`;

            const [result, countResult] = await Promise.all([
                pool.query(query, params),
                pool.query(countQuery, countParams)
            ]);

            res.json({
                restaurants: result.rows,
                total: parseInt(countResult.rows[0].total),
                limit: limitVal,
                offset: offsetVal
            });
        } catch (err) {
            log('error', 'Error en superadmin restaurants list', { error: err.message });
            res.status(500).json({ error: 'Error listando restaurantes' });
        }
    });

    // ========== RESTAURANT DETAIL ==========
    router.get('/superadmin/restaurants/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            if (isNaN(id) || id <= 0) {
                return res.status(400).json({ error: 'ID de restaurante inválido' });
            }

            const [result, usersResult] = await Promise.all([
                pool.query(
                    `SELECT r.*,
                        (SELECT COUNT(*) FROM usuarios u WHERE u.restaurante_id = r.id) as user_count,
                        (SELECT COUNT(*) FROM ingredientes i WHERE i.restaurante_id = r.id AND i.deleted_at IS NULL) as ingredient_count,
                        (SELECT COUNT(*) FROM recetas rec WHERE rec.restaurante_id = r.id AND rec.deleted_at IS NULL) as recipe_count
                     FROM restaurantes r WHERE r.id = $1`,
                    [id]
                ),
                pool.query(
                    'SELECT id, nombre, email, rol, email_verified, created_at FROM usuarios WHERE restaurante_id = $1 ORDER BY created_at',
                    [id]
                )
            ]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Restaurante no encontrado' });
            }

            res.json({
                ...result.rows[0],
                users: usersResult.rows
            });
        } catch (err) {
            log('error', 'Error en superadmin restaurant detail', { error: err.message });
            res.status(500).json({ error: 'Error obteniendo detalle de restaurante' });
        }
    });

    // ========== UPDATE RESTAURANT ==========
    router.patch('/superadmin/restaurants/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            if (isNaN(id) || id <= 0) {
                return res.status(400).json({ error: 'ID de restaurante inválido' });
            }

            const { plan, plan_status, max_users, moneda } = req.body;
            const updates = [];
            const params = [];
            let paramIndex = 1;

            if (plan !== undefined) {
                const validPlans = ['trial', 'starter', 'profesional', 'premium'];
                if (!validPlans.includes(plan)) {
                    return res.status(400).json({ error: `Plan inválido. Opciones: ${validPlans.join(', ')}` });
                }
                updates.push(`plan = $${paramIndex++}`);
                params.push(plan);

                // Auto-set trial_ends_at when switching to trial
                if (plan === 'trial') {
                    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
                    updates.push(`trial_ends_at = $${paramIndex++}`);
                    params.push(trialEndsAt);
                } else {
                    updates.push(`trial_ends_at = NULL`);
                }
            }
            if (plan_status !== undefined) {
                const validStatuses = ['trialing', 'active', 'canceled', 'past_due', 'paused', 'suspended'];
                if (!validStatuses.includes(plan_status)) {
                    return res.status(400).json({ error: `Estado inválido. Opciones: ${validStatuses.join(', ')}` });
                }
                updates.push(`plan_status = $${paramIndex++}`);
                params.push(plan_status);
            }
            if (max_users !== undefined) {
                const maxUsersVal = validateNumber(max_users, 2, 1, 999);
                updates.push(`max_users = $${paramIndex++}`);
                params.push(maxUsersVal);
            }
            if (moneda !== undefined) {
                const safeMoneda = sanitizeString(String(moneda).slice(0, 10)) || '€';
                updates.push(`moneda = $${paramIndex++}`);
                params.push(safeMoneda);
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No se proporcionaron campos para actualizar' });
            }

            params.push(id);
            const result = await pool.query(
                `UPDATE restaurantes SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
                params
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Restaurante no encontrado' });
            }

            log('info', 'Superadmin actualizó restaurante', {
                adminEmail: req.user.email,
                restauranteId: id,
                changes: req.body
            });

            res.json(result.rows[0]);
        } catch (err) {
            log('error', 'Error en superadmin restaurant update', { error: err.message });
            res.status(500).json({ error: 'Error actualizando restaurante' });
        }
    });

    // ========== RESTAURANT USERS ==========
    router.get('/superadmin/restaurants/:id/users', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            if (isNaN(id) || id <= 0) {
                return res.status(400).json({ error: 'ID de restaurante inválido' });
            }

            const restCheck = await pool.query('SELECT id FROM restaurantes WHERE id = $1', [id]);
            if (restCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Restaurante no encontrado' });
            }

            const result = await pool.query(
                'SELECT id, nombre, email, rol, email_verified, created_at FROM usuarios WHERE restaurante_id = $1 ORDER BY created_at',
                [id]
            );

            res.json(result.rows);
        } catch (err) {
            log('error', 'Error en superadmin restaurant users', { error: err.message });
            res.status(500).json({ error: 'Error obteniendo usuarios' });
        }
    });

    // ========== CREATE RESTAURANT ==========
    router.post('/superadmin/restaurants', async (req, res) => {
        const client = await pool.connect();
        try {
            const { nombre, email, plan, moneda } = req.body;
            if (!nombre || !email) {
                return res.status(400).json({ error: 'Nombre y email requeridos' });
            }

            await client.query('BEGIN');

            const validPlan = ['trial', 'starter', 'profesional', 'premium'].includes(plan) ? plan : 'trial';
            const trialEndsAt = validPlan === 'trial' ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) : null;

            const safeMoneda = moneda ? sanitizeString(String(moneda).slice(0, 10)) : '€';
            const restResult = await client.query(
                `INSERT INTO restaurantes (nombre, email, plan, plan_status, trial_ends_at, max_users, moneda)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [sanitizeString(nombre), email, validPlan, validPlan === 'trial' ? 'trialing' : 'active', trialEndsAt, PLAN_MAX_USERS[validPlan] || 5, safeMoneda]
            );
            const restauranteId = restResult.rows[0].id;

            // Si el usuario ya existe, vincularlo al nuevo restaurante sin crear uno nuevo.
            // Esto permite que un owner tenga N restaurantes bajo la misma cuenta.
            const existing = await client.query('SELECT id, nombre, email FROM usuarios WHERE email = $1', [email]);
            let userId;
            let tempPassword = null;

            if (existing.rows.length > 0) {
                userId = existing.rows[0].id;
                log('info', 'Usuario existente vinculado a nuevo restaurante desde superadmin', { email, restauranteId });
            } else {
                tempPassword = crypto.randomBytes(8).toString('hex');
                const passwordHash = await bcrypt.hash(tempPassword, 10);
                const userResult = await client.query(
                    `INSERT INTO usuarios (restaurante_id, email, password_hash, nombre, rol, email_verified)
                     VALUES ($1, $2, $3, $4, 'admin', TRUE) RETURNING id`,
                    [restauranteId, email, passwordHash, sanitizeString(nombre)]
                );
                userId = userResult.rows[0].id;
            }

            // Multi-restaurant junction table
            await client.query(
                'INSERT INTO usuario_restaurantes (usuario_id, restaurante_id, rol) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                [userId, restauranteId, 'admin']
            );

            await client.query('COMMIT');

            log('info', 'Superadmin creó restaurante', { admin: req.user.email, restauranteId, nombre, linkedExisting: !!existing.rows.length });
            res.status(201).json({ id: restauranteId, nombre, email, tempPassword, plan: validPlan });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error creando restaurante', { error: err.message });
            res.status(500).json({ error: 'Error creando restaurante' });
        } finally {
            client.release();
        }
    });

    // ========== RESET USER PASSWORD ==========
    router.post('/superadmin/users/:id/reset-password', async (req, res) => {
        try {
            const userId = parseInt(req.params.id);
            if (isNaN(userId) || userId <= 0) {
                return res.status(400).json({ error: 'ID inválido' });
            }
            const user = await pool.query('SELECT id, email, nombre FROM usuarios WHERE id = $1', [userId]);
            if (user.rows.length === 0) {
                return res.status(404).json({ error: 'Usuario no encontrado' });
            }
            const newPassword = crypto.randomBytes(8).toString('hex');
            const hash = await bcrypt.hash(newPassword, 10);
            await pool.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [hash, userId]);
            log('info', 'Superadmin reseteó password', { admin: req.user.email, targetUser: user.rows[0].email });
            res.json({ success: true, email: user.rows[0].email, tempPassword: newPassword });
        } catch (err) {
            log('error', 'Error reseteando password', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== SUSPEND RESTAURANT ==========
    router.delete('/superadmin/restaurants/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            if (isNaN(id) || id <= 0) {
                return res.status(400).json({ error: 'ID inválido' });
            }

            const result = await pool.query(
                `UPDATE restaurantes SET plan_status = 'suspended' WHERE id = $1 RETURNING id, nombre`,
                [id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Restaurante no encontrado' });
            }

            log('info', 'Superadmin suspendió restaurante', { admin: req.user.email, restauranteId: id });
            res.json({ success: true, ...result.rows[0] });
        } catch (err) {
            log('error', 'Error suspendiendo restaurante', { error: err.message });
            res.status(500).json({ error: 'Error suspendiendo restaurante' });
        }
    });

    // ========== IMPERSONATE RESTAURANT ==========
    router.post('/superadmin/restaurants/:id/impersonate', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            if (isNaN(id) || id <= 0) {
                return res.status(400).json({ error: 'ID inválido' });
            }

            const userResult = await pool.query(
                `SELECT u.id, u.email, u.nombre, u.rol FROM usuarios u WHERE u.restaurante_id = $1 AND u.rol = 'admin' LIMIT 1`,
                [id]
            );
            if (userResult.rows.length === 0) {
                return res.status(404).json({ error: 'Restaurante sin usuario admin' });
            }

            const targetUser = userResult.rows[0];
            const restResult = await pool.query('SELECT nombre FROM restaurantes WHERE id = $1', [id]);

            const token = jwt.sign(
                {
                    userId: targetUser.id, restauranteId: id, email: targetUser.email,
                    rol: 'admin', isSuperAdmin: false, impersonatedBy: req.user.email
                },
                JWT_SECRET,
                { expiresIn: '1h' }
            );

            log('warn', 'Superadmin impersonando restaurante', { admin: req.user.email, targetRestaurant: id, targetUser: targetUser.email });
            res.json({
                token,
                restaurante: restResult.rows[0]?.nombre,
                expiresIn: '1 hora',
                appUrl: APP_URL
            });
        } catch (err) {
            log('error', 'Error impersonando restaurante', { error: err.message });
            res.status(500).json({ error: 'Error impersonando restaurante' });
        }
    });

    // ========== AUDIT LOG ==========
    // GET /superadmin/audit-log — consulta auditoría con filtros
    // Filtros opcionales: restauranteId, tabla, userId, operacion, desde, hasta
    router.get('/superadmin/audit-log', async (req, res) => {
        try {
            const {
                restauranteId,
                tabla,
                userId,
                operacion,
                desde,
                hasta,
                limit,
                offset,
            } = req.query;

            const conditions = [];
            const params = [];
            let p = 1;

            if (restauranteId) {
                const n = parseInt(restauranteId, 10);
                if (!Number.isFinite(n)) {
                    return res.status(400).json({ error: 'restauranteId inválido' });
                }
                conditions.push(`al.restaurante_id = $${p++}`);
                params.push(n);
            }
            if (tabla) {
                conditions.push(`al.tabla = $${p++}`);
                params.push(String(tabla).slice(0, 50));
            }
            if (userId) {
                const n = parseInt(userId, 10);
                if (!Number.isFinite(n)) {
                    return res.status(400).json({ error: 'userId inválido' });
                }
                conditions.push(`al.user_id = $${p++}`);
                params.push(n);
            }
            if (operacion) {
                const op = String(operacion).toUpperCase();
                if (!['INSERT', 'UPDATE', 'DELETE'].includes(op)) {
                    return res.status(400).json({ error: 'operacion debe ser INSERT, UPDATE o DELETE' });
                }
                conditions.push(`al.operacion = $${p++}`);
                params.push(op);
            }
            if (desde) {
                conditions.push(`al.timestamp >= $${p++}`);
                params.push(desde);
            }
            if (hasta) {
                conditions.push(`al.timestamp <= $${p++}`);
                params.push(hasta);
            }

            const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
            const limitVal = validateNumber(limit, 100, 1, 500);
            const offsetVal = validateNumber(offset, 0, 0);

            const countParams = [...params];
            params.push(limitVal, offsetVal);

            const query = `
                SELECT al.id, al.timestamp, al.user_id, al.user_email,
                       al.restaurante_id, r.nombre AS restaurante_nombre,
                       al.tabla, al.operacion, al.registro_id,
                       al.datos_antes, al.datos_despues,
                       al.ip_address, al.user_agent
                FROM audit_log al
                LEFT JOIN restaurantes r ON r.id = al.restaurante_id
                ${where}
                ORDER BY al.timestamp DESC
                LIMIT $${p++} OFFSET $${p++}
            `;

            const countQuery = `SELECT COUNT(*)::int AS total FROM audit_log al ${where}`;

            const [rowsRes, countRes] = await Promise.all([
                pool.query(query, params),
                pool.query(countQuery, countParams),
            ]);

            res.json({
                total: countRes.rows[0].total,
                limit: limitVal,
                offset: offsetVal,
                rows: rowsRes.rows,
            });
        } catch (err) {
            log('error', 'Error en superadmin audit-log', { error: err.message });
            res.status(500).json({ error: 'Error obteniendo audit log' });
        }
    });

    // ========== SMOKE TEST TENANT ==========
    // Réplica del SQL scripts/smoke-test-tenant.sql como endpoint:
    // tras alta de un tenant (o periódicamente), llamar a este endpoint y
    // verificar que `ok: true`. Si alguno de los 8 checks tiene
    // items_problematicos > 0, la cuenta NO está coherente.
    //
    // Severity:
    //   high   → bug duro (datos huérfanos, stock corrupto, joins que duplican).
    //   medium → datos que rompen UX (nombres duplicados, recetas sin escandallo).
    //   low    → desviaciones del default (cpf != 1) — puede ser legítimo.
    const SMOKE_TEST_SEVERITY = {
        INGREDIENTES_HUERFANOS_PIVOT: 'high',
        STOCK_POSIBLE_DOBLE_MULTIPLICACION: 'high',
        STOCK_NEGATIVO: 'high',
        INGREDIENTE_CON_2_PROVEEDORES_PRINCIPALES: 'high',
        RECETAS_CON_INGS_INVALIDOS: 'high',
        INGREDIENTES_NOMBRE_DUPLICADO: 'medium',
        RECETAS_SIN_ESCANDALLO: 'medium',
        INGREDIENTES_CPF_DISTINTO_DE_1: 'low',
    };

    router.get('/superadmin/smoke-test/:restauranteId', async (req, res) => {
        try {
            const restauranteIdVal = validateId(req.params.restauranteId);
            if (!restauranteIdVal.valid) {
                return res.status(400).json({ error: 'restauranteId inválido' });
            }
            const restauranteId = restauranteIdVal.value;

            // Verificar que el tenant existe (no filtrar por deleted_at — soft-deleted
            // también es información útil para el smoke test).
            const tenantCheck = await pool.query(
                'SELECT id, nombre FROM restaurantes WHERE id = $1',
                [restauranteId]
            );
            if (tenantCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Tenant no encontrado' });
            }

            const result = await pool.query(`
                WITH
                ingredientes_huerfanos_pivot AS (
                    SELECT
                        'INGREDIENTES_HUERFANOS_PIVOT' AS check_name,
                        COUNT(*)::int AS items_problematicos,
                        (ARRAY_AGG(i.id::text || ':' || i.nombre))[1:10] AS detalle
                    FROM ingredientes i
                    WHERE i.restaurante_id = $1
                      AND i.deleted_at IS NULL
                      AND i.proveedor_id IS NOT NULL
                      AND NOT EXISTS (
                          SELECT 1 FROM ingredientes_proveedores ip WHERE ip.ingrediente_id = i.id
                      )
                ),
                stock_posible_doble_mult AS (
                    -- Solo dispara si el ingrediente está en alguna receta.
                    -- Razón: si nadie lo cocina, no afecta food cost ni invariantes
                    -- críticas. Productos fungibles (guantes, toallitas, mantelillos)
                    -- pueden tener stock alto + cpf grande de forma legítima sin que
                    -- sea bug — solo se inventarían, no descuentan en ventas.
                    SELECT
                        'STOCK_POSIBLE_DOBLE_MULTIPLICACION' AS check_name,
                        COUNT(*)::int AS items_problematicos,
                        (ARRAY_AGG(
                            i.id::text || ':' || i.nombre
                            || ' (stock=' || i.stock_actual::text
                            || ', cpf=' || i.cantidad_por_formato::text || ')'
                        ))[1:10] AS detalle
                    FROM ingredientes i
                    WHERE i.restaurante_id = $1
                      AND i.deleted_at IS NULL
                      AND i.stock_actual > 1000
                      AND COALESCE(i.cantidad_por_formato, 1) > 1
                      AND EXISTS (
                          SELECT 1 FROM recetas r
                          CROSS JOIN LATERAL jsonb_array_elements(
                              CASE WHEN jsonb_typeof(r.ingredientes) = 'array'
                                   THEN r.ingredientes ELSE '[]'::jsonb END
                          ) AS elem_chk
                          WHERE r.restaurante_id = $1
                            AND r.deleted_at IS NULL
                            AND (elem_chk->>'ingredienteId') ~ '^[0-9]+$'
                            AND (elem_chk->>'ingredienteId')::int = i.id
                      )
                ),
                stock_negativo AS (
                    SELECT
                        'STOCK_NEGATIVO' AS check_name,
                        COUNT(*)::int AS items_problematicos,
                        (ARRAY_AGG(i.id::text || ':' || i.nombre || ' (' || i.stock_actual::text || ')'))[1:10] AS detalle
                    FROM ingredientes i
                    WHERE i.restaurante_id = $1
                      AND i.deleted_at IS NULL
                      AND i.stock_actual < 0
                ),
                ingredientes_duplicados AS (
                    SELECT
                        'INGREDIENTES_NOMBRE_DUPLICADO' AS check_name,
                        COUNT(*)::int AS items_problematicos,
                        (ARRAY_AGG(clave || ' -> ids: ' || ids_text))[1:10] AS detalle
                    FROM (
                        SELECT
                            LOWER(TRIM(nombre)) AS clave,
                            STRING_AGG(id::text, ', ' ORDER BY id) AS ids_text
                        FROM ingredientes
                        WHERE restaurante_id = $1 AND deleted_at IS NULL
                        GROUP BY LOWER(TRIM(nombre))
                        HAVING COUNT(*) > 1
                    ) dup
                ),
                recetas_con_ings_invalidos AS (
                    SELECT
                        'RECETAS_CON_INGS_INVALIDOS' AS check_name,
                        COUNT(DISTINCT r.id)::int AS items_problematicos,
                        (ARRAY_AGG(DISTINCT r.id::text || ':' || r.nombre))[1:10] AS detalle
                    FROM recetas r
                    CROSS JOIN LATERAL jsonb_array_elements(
                        CASE WHEN jsonb_typeof(r.ingredientes) = 'array' THEN r.ingredientes ELSE '[]'::jsonb END
                    ) AS elem
                    WHERE r.restaurante_id = $1
                      AND r.deleted_at IS NULL
                      AND (elem->>'ingredienteId') ~ '^[0-9]+$'
                      AND (elem->>'ingredienteId')::int < 100000
                      AND NOT EXISTS (
                          SELECT 1 FROM ingredientes i
                          WHERE i.id = (elem->>'ingredienteId')::int
                            AND i.restaurante_id = $1
                            AND i.deleted_at IS NULL
                      )
                ),
                recetas_sin_escandallo AS (
                    SELECT
                        'RECETAS_SIN_ESCANDALLO' AS check_name,
                        COUNT(*)::int AS items_problematicos,
                        (ARRAY_AGG(r.id::text || ':' || r.nombre))[1:10] AS detalle
                    FROM recetas r
                    WHERE r.restaurante_id = $1
                      AND r.deleted_at IS NULL
                      AND LOWER(COALESCE(r.categoria, '')) NOT IN ('base', 'bebidas', 'bebida')
                      AND (r.ingredientes IS NULL
                           OR jsonb_typeof(r.ingredientes) != 'array'
                           OR jsonb_array_length(r.ingredientes) = 0)
                ),
                ingredientes_cpf_no_uno AS (
                    SELECT
                        'INGREDIENTES_CPF_DISTINTO_DE_1' AS check_name,
                        COUNT(*)::int AS items_problematicos,
                        (ARRAY_AGG(i.id::text || ':' || i.nombre || ' (cpf=' || i.cantidad_por_formato::text || ')'))[1:10] AS detalle
                    FROM ingredientes i
                    WHERE i.restaurante_id = $1
                      AND i.deleted_at IS NULL
                      AND i.cantidad_por_formato IS NOT NULL
                      AND i.cantidad_por_formato != 1
                ),
                proveedor_principal_duplicado AS (
                    SELECT
                        'INGREDIENTE_CON_2_PROVEEDORES_PRINCIPALES' AS check_name,
                        COUNT(*)::int AS items_problematicos,
                        (ARRAY_AGG(i.nombre || ' (ing_id=' || ing_id::text || ', ' || cnt::text || ' principales)'))[1:10] AS detalle
                    FROM (
                        SELECT
                            ip.ingrediente_id AS ing_id,
                            COUNT(*) AS cnt
                        FROM ingredientes_proveedores ip
                        JOIN ingredientes i_inner ON i_inner.id = ip.ingrediente_id
                        WHERE i_inner.restaurante_id = $1
                          AND i_inner.deleted_at IS NULL
                          AND ip.es_proveedor_principal = TRUE
                        GROUP BY ip.ingrediente_id
                        HAVING COUNT(*) > 1
                    ) sub
                    JOIN ingredientes i ON i.id = sub.ing_id
                )
                SELECT * FROM ingredientes_huerfanos_pivot
                UNION ALL SELECT * FROM stock_posible_doble_mult
                UNION ALL SELECT * FROM stock_negativo
                UNION ALL SELECT * FROM ingredientes_duplicados
                UNION ALL SELECT * FROM recetas_con_ings_invalidos
                UNION ALL SELECT * FROM recetas_sin_escandallo
                UNION ALL SELECT * FROM ingredientes_cpf_no_uno
                UNION ALL SELECT * FROM proveedor_principal_duplicado
            `, [restauranteId]);

            const checks = result.rows.map(r => ({
                check_name: r.check_name,
                items_problematicos: r.items_problematicos,
                severity: SMOKE_TEST_SEVERITY[r.check_name] || 'medium',
                detalle: r.detalle || [],
            }));

            const highIssues = checks.filter(c => c.severity === 'high' && c.items_problematicos > 0);
            const mediumIssues = checks.filter(c => c.severity === 'medium' && c.items_problematicos > 0);
            const lowIssues = checks.filter(c => c.severity === 'low' && c.items_problematicos > 0);

            res.json({
                restauranteId,
                restauranteNombre: tenantCheck.rows[0].nombre,
                ok: highIssues.length === 0 && mediumIssues.length === 0,
                summary: {
                    high: highIssues.length,
                    medium: mediumIssues.length,
                    low: lowIssues.length,
                },
                checks,
            });
        } catch (err) {
            log('error', 'Error en superadmin smoke-test', { error: err.message });
            res.status(500).json({ error: 'Error ejecutando smoke test' });
        }
    });

    return router;
};
