/**
 * Repository: RecipeRepository
 * Acceso a datos de recetas
 */

const Recipe = require('../../domain/entities/Recipe');

class RecipeRepository {
    constructor(pool) {
        this.pool = pool;
    }

    /**
     * Busca receta por ID
     */
    async findById(id, restaurantId) {
        const query = `
            SELECT * FROM recetas
            WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL
        `;
        const result = await this.pool.query(query, [id, restaurantId]);
        return result.rows[0] ? new Recipe(result.rows[0]) : null;
    }

    /**
     * Busca todas las recetas activas
     */
    async findActive(restaurantId) {
        const query = `
            SELECT * FROM recetas
            WHERE restaurante_id = $1 AND (activo = true OR activo IS NULL) AND deleted_at IS NULL
            ORDER BY nombre
        `;
        const result = await this.pool.query(query, [restaurantId]);
        return result.rows.map(row => new Recipe(row));
    }

    /**
     * Busca recetas que usan un ingrediente específico
     */
    async findByIngredient(ingredientId, restaurantId) {
        const query = `
            SELECT * FROM recetas
            WHERE restaurante_id = $1
              AND (activo = true OR activo IS NULL)
              AND deleted_at IS NULL
              AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(ingredientes) AS ing
                  WHERE (ing->>'ingrediente_id')::int = $2
              )
        `;
        const result = await this.pool.query(query, [restaurantId, ingredientId]);
        return result.rows.map(row => new Recipe(row));
    }

    /**
     * Actualiza costes de una receta
     */
    async updateCost(id, costData) {
        const query = `
            UPDATE recetas
            SET
                coste_calculado = $1,
                coste_por_racion = $2,
                margen_porcentaje = $3,
                food_cost = $4,
                last_cost_calculation = NOW(),
                updated_at = NOW()
            WHERE id = $5
            RETURNING *
        `;
        const result = await this.pool.query(query, [
            costData.totalCost,
            costData.costPerPortion,
            costData.marginPercentage,
            costData.foodCostPercentage,
            id
        ]);
        return result.rows[0] ? new Recipe(result.rows[0]) : null;
    }

    /**
     * Crea una nueva receta
     */
    async create(recipeData, restaurantId) {
        const query = `
            INSERT INTO recetas (
                restaurante_id, nombre, descripcion, categoria_id,
                raciones, precio_venta, ingredientes, activo
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)
            RETURNING *
        `;
        const result = await this.pool.query(query, [
            restaurantId,
            recipeData.nombre,
            recipeData.descripcion,
            recipeData.categoria_id,
            recipeData.raciones || 1,
            recipeData.precio_venta,
            JSON.stringify(recipeData.ingredientes || [])
        ]);
        return new Recipe(result.rows[0]);
    }

    /**
     * Actualiza una receta
     */
    async update(id, recipeData, restaurantId) {
        const fields = [];
        const values = [];
        let paramCount = 1;

        const allowedFields = ['nombre', 'descripcion', 'categoria_id', 'raciones', 'precio_venta', 'ingredientes', 'activo'];

        for (const field of allowedFields) {
            if (recipeData[field] !== undefined) {
                fields.push(`${field} = $${paramCount}`);
                values.push(field === 'ingredientes' ? JSON.stringify(recipeData[field]) : recipeData[field]);
                paramCount++;
            }
        }

        if (fields.length === 0) return null;

        fields.push(`updated_at = NOW()`);
        values.push(id, restaurantId);

        const query = `
            UPDATE recetas
            SET ${fields.join(', ')}
            WHERE id = $${paramCount} AND restaurante_id = $${paramCount + 1}
            RETURNING *
        `;

        const result = await this.pool.query(query, values);
        return result.rows[0] ? new Recipe(result.rows[0]) : null;
    }

    /**
     * Soft delete
     */
    async delete(id, restaurantId) {
        const query = `
            UPDATE recetas
            SET deleted_at = NOW(), activo = false
            WHERE id = $1 AND restaurante_id = $2
            RETURNING id
        `;
        const result = await this.pool.query(query, [id, restaurantId]);
        return result.rowCount > 0;
    }
}

module.exports = RecipeRepository;
