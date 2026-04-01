/**
 * Integrations Routes — External service monitoring for superadmin dashboard
 * Also provides the missing /superadmin/health and /superadmin/errors endpoints.
 */
const { Router } = require('express');
const { authMiddleware, requireSuperAdmin } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { sentryService, uptimeKumaService, n8nService } = require('../services/integrations');

module.exports = function (pool) {
    const router = Router();

    // ========== INTEGRATIONS OVERVIEW (all 3 services) ==========
    router.get('/superadmin/integrations/overview', authMiddleware, requireSuperAdmin, async (req, res) => {
        try {
            const [sentry, uptime, n8n] = await Promise.allSettled([
                sentryService.getStatus(),
                uptimeKumaService.getStatus(),
                n8nService.getStatus()
            ]);

            res.json({
                sentry: sentry.status === 'fulfilled' ? sentry.value : { status: 'error', message: sentry.reason?.message },
                uptimeKuma: uptime.status === 'fulfilled' ? uptime.value : { status: 'error', message: uptime.reason?.message },
                n8n: n8n.status === 'fulfilled' ? n8n.value : { status: 'error', message: n8n.reason?.message },
                timestamp: new Date().toISOString()
            });
        } catch (err) {
            log('error', 'Error fetching integrations overview', { error: err.message });
            res.status(500).json({ error: 'Error obteniendo estado de integraciones' });
        }
    });

    // ========== SENTRY DETAIL ==========
    router.get('/superadmin/integrations/sentry', authMiddleware, requireSuperAdmin, async (req, res) => {
        try {
            const data = await sentryService.getStatus();
            res.json(data);
        } catch (err) {
            log('error', 'Error fetching Sentry status', { error: err.message });
            res.status(500).json({ error: 'Error obteniendo estado de Sentry' });
        }
    });

    // ========== UPTIME KUMA DETAIL ==========
    router.get('/superadmin/integrations/uptime', authMiddleware, requireSuperAdmin, async (req, res) => {
        try {
            const data = await uptimeKumaService.getStatus();
            res.json(data);
        } catch (err) {
            log('error', 'Error fetching Uptime Kuma status', { error: err.message });
            res.status(500).json({ error: 'Error obteniendo estado de Uptime Kuma' });
        }
    });

    // ========== N8N DETAIL ==========
    router.get('/superadmin/integrations/n8n', authMiddleware, requireSuperAdmin, async (req, res) => {
        try {
            const data = await n8nService.getStatus();
            res.json(data);
        } catch (err) {
            log('error', 'Error fetching n8n status', { error: err.message });
            res.status(500).json({ error: 'Error obteniendo estado de n8n' });
        }
    });

    // ========== SUPERADMIN HEALTH (system status) ==========
    router.get('/superadmin/health', authMiddleware, requireSuperAdmin, async (req, res) => {
        try {
            const startMs = Date.now();
            await pool.query('SELECT 1');
            const dbLatency = Date.now() - startMs;

            const memUsage = process.memoryUsage();
            const [restCount, userCount, recipeIssues, stockIssues, stockValue, salesToday] = await Promise.all([
                pool.query('SELECT COUNT(*) as total FROM restaurantes'),
                pool.query('SELECT COUNT(*) as total FROM usuarios'),
                pool.query("SELECT COUNT(*) as total FROM recetas WHERE deleted_at IS NULL AND (ingredientes IS NULL OR ingredientes::text = '[]')"),
                pool.query('SELECT COUNT(*) as total FROM ingredientes WHERE stock_actual < 0 AND deleted_at IS NULL'),
                pool.query('SELECT COALESCE(SUM(stock_actual * (COALESCE(precio, 0) / GREATEST(COALESCE(cantidad_por_formato, 1), 1))), 0) as total FROM ingredientes WHERE stock_actual > 0 AND deleted_at IS NULL'),
                pool.query("SELECT COALESCE(SUM(total), 0) as total FROM ventas WHERE fecha::date = CURRENT_DATE AND deleted_at IS NULL")
            ]);

            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                server: {
                    uptime_seconds: Math.floor(process.uptime()),
                    memory_mb: {
                        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
                        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
                        rss: Math.round(memUsage.rss / 1024 / 1024)
                    },
                    node_version: process.version
                },
                database: {
                    ok: true,
                    response_ms: dbLatency,
                    pool: {
                        total: pool.totalCount,
                        idle: pool.idleCount,
                        waiting: pool.waitingCount
                    }
                },
                platform: {
                    total_restaurants: parseInt(restCount.rows[0].total),
                    total_users: parseInt(userCount.rows[0].total),
                    recipes_without_ingredients: parseInt(recipeIssues.rows[0].total),
                    negative_stock_items: parseInt(stockIssues.rows[0].total),
                    total_stock_value: parseFloat(stockValue.rows[0].total),
                    todays_sales_total: parseFloat(salesToday.rows[0].total)
                }
            });
        } catch (err) {
            log('error', 'Error en superadmin health', { error: err.message });
            res.status(500).json({ status: 'unhealthy', error: err.message });
        }
    });

    // ========== SUPERADMIN ERRORS (Sentry issues for dashboard widget) ==========
    router.get('/superadmin/errors', authMiddleware, requireSuperAdmin, async (req, res) => {
        try {
            const data = await sentryService.getStatus();
            if (data.status === 'connected') {
                res.json({
                    errors: (data.issues || []).map(i => ({
                        title: i.title,
                        count: i.count,
                        level: i.level,
                        lastSeen: i.lastSeen,
                        permalink: i.permalink
                    }))
                });
            } else {
                res.json({ errors: [], message: data.message || 'Sentry no configurado' });
            }
        } catch (err) {
            log('error', 'Error fetching errors', { error: err.message });
            res.status(500).json({ error: 'Error obteniendo errores' });
        }
    });

    return router;
};
