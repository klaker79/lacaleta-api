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
const { validateNumber, sanitizeString } = require('../utils/validators');
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

    return router;
};
