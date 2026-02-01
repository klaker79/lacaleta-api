/**
 * Controller: IngredientController
 * Maneja requests HTTP para ingredientes
 */

const IngredientRepository = require('../../../infrastructure/repositories/IngredientRepository');
const pool = require('../../../infrastructure/database/connection');

class IngredientController {
    /**
     * GET /api/ingredients
     */
    static async list(req, res, next) {
        try {
            const restaurantId = req.restauranteId;
            const repo = new IngredientRepository(pool);
            const ingredients = await repo.findActive(restaurantId);

            // Devolver array directo (compatible con frontend)
            res.json(ingredients.map(i => i.toDTO ? i.toDTO() : i));
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/ingredients/:id
     */
    static async getById(req, res, next) {
        try {
            const { id } = req.params;
            const restaurantId = req.restauranteId;
            const repo = new IngredientRepository(pool);
            const ingredient = await repo.findById(id, restaurantId);

            if (!ingredient) {
                return res.status(404).json({ error: 'Ingrediente no encontrado' });
            }

            res.json(ingredient.toDTO ? ingredient.toDTO() : ingredient);
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/ingredients
     */
    static async create(req, res, next) {
        try {
            const restaurantId = req.restauranteId;
            const data = req.body;

            const query = `
                INSERT INTO ingredientes 
                    (nombre, categoria, unidad, precio, stock_actual, stock_minimo, proveedor_id, restaurante_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING *
            `;
            const result = await pool.query(query, [
                data.nombre,
                data.categoria || data.familia || null,
                data.unidad,
                data.precio || 0,
                data.stock_actual || 0,
                data.stock_minimo || 0,
                data.proveedor_id || data.proveedorId || null,
                restaurantId
            ]);

            res.status(201).json(result.rows[0]);
        } catch (error) {
            next(error);
        }
    }

    /**
     * PUT /api/ingredients/:id
     */
    static async update(req, res, next) {
        try {
            const { id } = req.params;
            const restaurantId = req.restauranteId;
            const data = req.body;

            const query = `
                UPDATE ingredientes 
                SET nombre = COALESCE($1, nombre),
                    categoria = COALESCE($2, categoria),
                    unidad = COALESCE($3, unidad),
                    precio = COALESCE($4, precio),
                    stock_actual = COALESCE($5, stock_actual),
                    stock_minimo = COALESCE($6, stock_minimo),
                    proveedor_id = COALESCE($7, proveedor_id),
                    updated_at = NOW()
                WHERE id = $8 AND restaurante_id = $9
                RETURNING *
            `;
            const result = await pool.query(query, [
                data.nombre,
                data.categoria || data.familia,
                data.unidad,
                data.precio,
                data.stock_actual,
                data.stock_minimo,
                data.proveedor_id || data.proveedorId,
                id,
                restaurantId
            ]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Ingrediente no encontrado' });
            }

            res.json(result.rows[0]);
        } catch (error) {
            next(error);
        }
    }

    /**
     * DELETE /api/ingredients/:id
     */
    static async delete(req, res, next) {
        try {
            const { id } = req.params;
            const restaurantId = req.restauranteId;

            const query = `
                UPDATE ingredientes 
                SET deleted_at = NOW()
                WHERE id = $1 AND restaurante_id = $2
                RETURNING id
            `;
            const result = await pool.query(query, [id, restaurantId]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Ingrediente no encontrado' });
            }

            res.json({ message: 'Ingrediente eliminado', id: result.rows[0].id });
        } catch (error) {
            next(error);
        }
    }
}

module.exports = IngredientController;
