/**
 * Routes: Alertas
 */

const router = require('express').Router();
const AlertController = require('../controllers/AlertController');

// GET /api/v2/alerts - Listar alertas activas
router.get('/', AlertController.list);

// GET /api/v2/alerts/stats - Estadísticas
router.get('/stats', AlertController.getStats);

// POST /api/v2/alerts/:id/acknowledge - Marcar como vista
router.post('/:id/acknowledge', AlertController.acknowledge);

// POST /api/v2/alerts/:id/resolve - Resolver
router.post('/:id/resolve', AlertController.resolve);

// GET /api/v2/alerts/history - Historial con filtros
router.get('/history', AlertController.history);

module.exports = router;
