/**
 * Super Admin Routes — Platform management across all restaurants
 * All routes require authMiddleware + requireSuperAdmin
 */
const { Router } = require('express');
const { authMiddleware, requireSuperAdmin } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { log } = require('../utils/logger');
const { validateNumber } = require('../utils/validators');

module.exports = function (pool) {
    const router = Router();

    // Apply auth + superadmin + rate limiting to all /superadmin routes
    router.use('/superadmin', authMiddleware, requireSuperAdmin, authLimiter);

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

            const { plan, plan_status, max_users } = req.body;
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
            }
            if (plan_status !== undefined) {
                const validStatuses = ['trialing', 'active', 'canceled', 'past_due', 'paused'];
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

    return router;
};
