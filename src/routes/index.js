/**
 * ============================================
 * routes/index.js - Agregador de Rutas
 * ============================================
 *
 * Centraliza todas las rutas de la API en un solo archivo.
 * El server.js solo necesita importar este archivo.
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const express = require('express');
const router = express.Router();

// ========== RUTAS PÚBLICAS ==========

// Health Check
router.get('/health', async (req, res) => {
    try {
        const { pool } = require('../config/database');
        await pool.query('SELECT 1');
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '2.5.0'
        });
    } catch (e) {
        res.status(503).json({ status: 'unhealthy', error: e.message });
    }
});

// API Info
router.get('/', (req, res) => {
    res.json({
        message: '🍽️ MindLoop CostOS API',
        version: '2.5.0',
        status: 'running',
        docs: {
            health: '/api/health',
            login: 'POST /api/auth/login',
            ingredients: 'GET /api/ingredients',
            recipes: 'GET /api/recipes'
        }
    });
});

// ========== IMPORTAR RUTAS MODULARIZADAS ==========
// Nota: Las rutas se irán añadiendo a medida que se extraigan del server.js

// Por ahora, este archivo sirve como punto central de agregación.
// Las rutas existentes en server.js seguirán funcionando hasta que se migren.

module.exports = router;
