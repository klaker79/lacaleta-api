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
const inventoryRoutes = require('./inventory.routes');
const staffRoutes = require('./staff.routes');
const expenseRoutes = require('./expense.routes');
const analyticsRoutes = require('./analytics.routes');
const intelligenceRoutes = require('./intelligence.routes');
const mermaRoutes = require('./merma.routes');

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
            modules: 12
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
        modules: ['auth', 'ingredients', 'recipes', 'suppliers', 'orders', 'sales', 'inventory', 'staff', 'expenses', 'analytics', 'intelligence', 'mermas'],
        endpoints: 71,
        docs: {
            health: 'GET /api/health',
            auth: 'POST /api/auth/login',
            ingredients: 'GET /api/ingredients',
            recipes: 'GET /api/recipes',
            suppliers: 'GET /api/suppliers',
            orders: 'GET /api/orders',
            sales: 'GET /api/sales',
            inventory: 'GET /api/inventory/complete',
            staff: 'GET /api/staff/empleados',
            expenses: 'GET /api/expenses',
            analytics: 'GET /api/analytics/menu-engineering',
            intelligence: 'GET /api/intelligence/freshness',
            mermas: 'GET /api/mermas'
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
router.use('/inventory', inventoryRoutes);
router.use('/staff', staffRoutes);
router.use('/expenses', expenseRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/intelligence', intelligenceRoutes);
router.use('/mermas', mermaRoutes);

// ========== RUTAS LEGACY (Compatibilidad Frontend) ==========
// Alias para mantener compatibilidad con frontend existente
router.use('/gastos-fijos', expenseRoutes);           // /api/gastos-fijos → /api/expenses
router.use('/empleados', staffRoutes);                 // /api/empleados (legacy alias)
router.use('/horarios', staffRoutes);                  // /api/horarios (legacy alias)
router.use('/proveedores', supplierRoutes);           // /api/proveedores → /api/suppliers
router.use('/pedidos', orderRoutes);                   // /api/pedidos → /api/orders
router.use('/analysis', analyticsRoutes);              // /api/analysis → /api/analytics
router.use('/balance', analyticsRoutes);               // /api/balance → /api/analytics/balance
router.use('/daily', analyticsRoutes);                 // /api/daily → /api/analytics/daily

// Redirect especial para recipes-variants
const recipeVariantsRouter = require('./recipe.routes');
router.get('/recipes-variants', require('../middleware/auth').authMiddleware, async (req, res) => {
    const { pool } = require('../config/database');
    try {
        const result = await pool.query(
            'SELECT * FROM recetas_variantes WHERE restaurante_id = $1 ORDER BY receta_id, precio_venta DESC',
            [req.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

module.exports = router;


