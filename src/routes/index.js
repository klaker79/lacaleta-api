/**
 * ============================================
 * routes/index.js - Agregador de Rutas
 * ============================================
 *
 * Centraliza todas las rutas de la API.
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const express = require('express');
const router = express.Router();

// ========== IMPORTAR RUTAS MODULARIZADAS ==========
const authRoutes = require('./auth.routes');
const ingredientRoutes = require('./ingredient.routes');
const recipeRoutes = require('./recipe.routes');
const supplierRoutes = require('./supplier.routes');
const orderRoutes = require('./order.routes');
const saleRoutes = require('./sale.routes');

// ========== RUTAS PÚBLICAS ==========

// Health Check
router.get('/health', async (req, res) => {
    try {
        const { pool } = require('../config/database');
        await pool.query('SELECT 1');
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '2.5.0',
            architecture: 'modular',
            modules: 6
        });
    } catch (e) {
        res.status(503).json({ status: 'unhealthy', error: e.message });
    }
});

// API Info
router.get('/', (req, res) => {
    res.json({
        message: '🍽️ MindLoop CostOS API (Modular)',
        version: '2.5.0',
        status: 'running',
        modules: ['auth', 'ingredients', 'recipes', 'suppliers', 'orders', 'sales'],
        endpoints: 37,
        docs: {
            health: 'GET /api/health',
            auth: 'POST /api/auth/login',
            ingredients: 'GET /api/ingredients',
            recipes: 'GET /api/recipes',
            suppliers: 'GET /api/suppliers',
            orders: 'GET /api/orders',
            sales: 'GET /api/sales'
        }
    });
});

// ========== MONTAR RUTAS ==========
router.use('/auth', authRoutes);
router.use('/ingredients', ingredientRoutes);
router.use('/recipes', recipeRoutes);
router.use('/suppliers', supplierRoutes);
router.use('/orders', orderRoutes);
router.use('/sales', saleRoutes);

// TODO: Añadir rutas de inventario, analytics, staff, expenses...

module.exports = router;
