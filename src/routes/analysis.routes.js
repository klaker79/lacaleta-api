/**
 * analysis Routes — Extracted from server.js
 * Menu engineering analysis (BCG matrix)
 */
const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { costlyApiLimiter } = require('../middleware/rateLimit');
// 2026-06-08: requirePlan retirado. El gating ahora es global en server.js
// (modelo single-plan: Self/Pro con misma funcionalidad).
const { log } = require('../utils/logger');
const {
    getMenuEngineering,
    getOmnesAnalysis
} = require('../services/menuEngineeringService');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== ANÁLISIS AVANZADO ==========
    // 2026-06-06: la lógica vive en `services/menuEngineeringService` para
    // que tanto los endpoints REST como las tools del chat IA usen el mismo
    // cálculo. UNA fuente de verdad — sin riesgo de divergencia entre la UI
    // y lo que el chat responde.
    router.get('/analysis/menu-engineering', costlyApiLimiter, authMiddleware, async (req, res) => {
        try {
            const resultado = await getMenuEngineering(pool, req.restauranteId, {
                desde: req.query.desde,
                hasta: req.query.hasta
            });
            res.json(resultado);
        } catch (err) {
            log('error', 'Error análisis menú', { error: err.message });
            res.status(500).json({ error: 'Error analizando menú', data: [] });
        }
    });

    /**
     * GET /analysis/omnes?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
     *
     * Principios de Omnes — análisis avanzado de la estrategia de carta.
     *   1. Dispersión: ratio precio_max / precio_min de la carta food. Ideal ≤ 2.5.
     *   2. Amplitud de gama: distribución % en baja/media/alta. Ideal 25/50/25.
     *   3. Relación calidad-precio: precio_medio_vendido / precio_medio_ofertado. Ideal 0.95-1.05.
     */
    router.get('/analysis/omnes', costlyApiLimiter, authMiddleware, async (req, res) => {
        try {
            const resultado = await getOmnesAnalysis(pool, req.restauranteId, {
                desde: req.query.desde,
                hasta: req.query.hasta
            });
            res.json(resultado);
        } catch (err) {
            log('error', 'Error /analysis/omnes', { error: err.message });
            res.status(500).json({ error: 'Error calculando Principios de Omnes' });
        }
    });


    return router;
};
