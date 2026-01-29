/**
 * Routes v2: Recetas con arquitectura limpia
 * Gradualmente reemplazará las rutas legacy
 */

const router = require('express').Router();
const RecipeController = require('../controllers/RecipeController');
const validate = require('../middleware/validate');
const { calculateCostSchema, createRecipeSchema, updateRecipeSchema } = require('../validators/recipeSchema');

// Nota: authMiddleware se aplica en el router padre

// GET /api/v2/recipes - Listar recetas
router.get('/', RecipeController.list);

// GET /api/v2/recipes/stats - Estadísticas de costes
router.get('/stats', RecipeController.getStats);

// GET /api/v2/recipes/:id - Obtener receta
router.get('/:id', validate(calculateCostSchema), RecipeController.getById);

// POST /api/v2/recipes - Crear receta
router.post('/', validate(createRecipeSchema), RecipeController.create);

// PUT /api/v2/recipes/:id - Actualizar receta
router.put('/:id', validate(updateRecipeSchema), RecipeController.update);

// DELETE /api/v2/recipes/:id - Eliminar receta
router.delete('/:id', validate(calculateCostSchema), RecipeController.delete);

// POST /api/v2/recipes/:id/calculate-cost - Calcular coste
router.post('/:id/calculate-cost', validate(calculateCostSchema), RecipeController.calculateCost);

// POST /api/v2/recipes/recalculate-all - Recalcular todas
router.post('/recalculate-all', RecipeController.recalculateAll);

module.exports = router;
