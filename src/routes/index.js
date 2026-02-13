/**
 * Route Registry — Central mounting point for all domain routes
 * 
 * All routes are mounted under /api prefix.
 * Each route file exports a factory function: (pool) => Router
 * Auth routes additionally receive config: (pool, { resend, JWT_SECRET, INVITATION_CODE })
 */
module.exports = function mountRoutes(app, pool, { resend }) {
    const config = {
        resend,
        JWT_SECRET: process.env.JWT_SECRET,
        INVITATION_CODE: process.env.INVITATION_CODE
    };

    // Auth + Team management
    app.use('/api', require('./auth.routes')(pool, config));

    // Core domain routes
    app.use('/api', require('./ingredients.routes')(pool));
    app.use('/api', require('./recipes.routes')(pool));
    app.use('/api', require('./inventory.routes')(pool));
    app.use('/api', require('./analysis.routes')(pool));
    app.use('/api', require('./orders.routes')(pool));
    app.use('/api', require('./sales.routes')(pool));
    app.use('/api', require('./staff.routes')(pool));
    app.use('/api', require('./gastos.routes')(pool));
    app.use('/api', require('./balance.routes')(pool));
    app.use('/api', require('./intelligence.routes')(pool));
    app.use('/api', require('./mermas.routes')(pool));
    app.use('/api', require('./system.routes')(pool));

    // Suppliers — already controller-based (Fase 4B)
    const { authMiddleware } = require('../middleware/auth');
    const SupplierController = require('../interfaces/http/controllers/SupplierController');
    app.get('/api/suppliers', authMiddleware, SupplierController.list);
    app.get('/api/suppliers/:id', authMiddleware, SupplierController.getById);
    app.post('/api/suppliers', authMiddleware, SupplierController.create);
    app.put('/api/suppliers/:id', authMiddleware, SupplierController.update);
    app.delete('/api/suppliers/:id', authMiddleware, SupplierController.delete);
};
