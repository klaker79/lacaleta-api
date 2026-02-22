/**
 * Route Registry — Central mounting point for all domain routes
 * 
 * All routes are mounted under /api prefix.
 * Each route file exports a factory function: (pool) => Router
 * Auth routes additionally receive config: (pool, { resend, JWT_SECRET, INVITATION_CODE })
 * 
 * DEFENSIVE: Each module is wrapped in try-catch so one failing module
 * does not prevent the rest from loading.
 */
module.exports = function mountRoutes(app, pool, { resend }) {
    const errors = [];
    const config = {
        resend,
        JWT_SECRET: process.env.JWT_SECRET,
        INVITATION_CODE: process.env.INVITATION_CODE
    };

    function mount(name, factory, ...args) {
        try {
            const router = factory(...args);
            app.use('/api', router);
            console.log(`[ROUTES] ✅ ${name} mounted`);
        } catch (err) {
            console.error(`[ROUTES] ❌ ${name} FAILED:`, err.message);
            console.error(err.stack);
            errors.push({ module: name, error: err.message });
        }
    }

    // Auth + Team management
    mount('auth', require('./auth.routes'), pool, config);

    // Core domain routes
    mount('ingredients', require('./ingredients.routes'), pool);
    mount('recipes', require('./recipes.routes'), pool);
    mount('inventory', require('./inventory.routes'), pool);
    mount('analysis', require('./analysis.routes'), pool);
    mount('orders', require('./orders.routes'), pool);
    mount('sales', require('./sales.routes'), pool);
    mount('staff', require('./staff.routes'), pool);
    mount('gastos', require('./gastos.routes'), pool);
    mount('balance', require('./balance.routes'), pool);
    mount('intelligence', require('./intelligence.routes'), pool);
    mount('mermas', require('./mermas.routes'), pool);
    mount('system', require('./system.routes'), pool);
    mount('stripe', require('./stripe.routes'), pool);
    mount('superadmin', require('./superadmin.routes'), pool);

    // Suppliers — already controller-based (Fase 4B)
    try {
        const { authMiddleware } = require('../middleware/auth');
        const SupplierController = require('../interfaces/http/controllers/SupplierController');
        app.get('/api/suppliers', authMiddleware, SupplierController.list);
        app.get('/api/suppliers/:id', authMiddleware, SupplierController.getById);
        app.post('/api/suppliers', authMiddleware, SupplierController.create);
        app.put('/api/suppliers/:id', authMiddleware, SupplierController.update);
        app.delete('/api/suppliers/:id', authMiddleware, SupplierController.delete);
        console.log('[ROUTES] ✅ suppliers mounted');
    } catch (err) {
        console.error('[ROUTES] ❌ suppliers FAILED:', err.message);
        errors.push({ module: 'suppliers', error: err.message });
    }

    console.log('[ROUTES] Route mounting complete');
    return errors;
};
