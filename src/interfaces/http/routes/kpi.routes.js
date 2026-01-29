/**
 * Routes: KPIs
 */

const router = require('express').Router();
const KPIController = require('../controllers/KPIController');

router.get('/daily', KPIController.getDaily);
router.get('/monthly', KPIController.getMonthly);
router.get('/comparison', KPIController.getComparison);
router.get('/top-recipes', KPIController.getTopRecipes);

module.exports = router;
