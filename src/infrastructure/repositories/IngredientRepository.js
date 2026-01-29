/**
 * Repository: IngredientRepository
 * Acceso a datos de ingredientes
 */

const Ingredient = require('../../domain/entities/Ingredient');

class IngredientRepository {
    constructor(pool) {
        this.pool = pool;
    }

    /**
     * Busca ingrediente por ID
     */
    async findById(id, restaurantId) {
        const query = `
            SELECT * FROM ingredientes
            WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL
        `;
        const result = await this.pool.query(query, [id, restaurantId]);
        return result.rows[0] ? new Ingredient(result.rows[0]) : null;
    }

    /**
     * Busca múltiples ingredientes por IDs
     */
    async findByIds(ids, restaurantId) {
        if (!ids.length) return [];

        const query = `
            SELECT * FROM ingredientes
            WHERE id = ANY($1) AND restaurante_id = $2 AND deleted_at IS NULL
        `;
        const result = await this.pool.query(query, [ids, restaurantId]);
        return result.rows.map(row => new Ingredient(row));
    }

    /**
     * Busca todos los ingredientes activos
     */
    async findActive(restaurantId) {
        const query = `
            SELECT * FROM ingredientes
            WHERE restaurante_id = $1 AND activo = true AND deleted_at IS NULL
            ORDER BY nombre
        `;
        const result = await this.pool.query(query, [restaurantId]);
        return result.rows.map(row => new Ingredient(row));
    }

    /**
     * Actualiza precio de un ingrediente
     */
    async updatePrice(id, newPrice, restaurantId) {
        // Primero obtener precio anterior
        const current = await this.findById(id, restaurantId);
        if (!current) return null;

        const oldPrice = current.pricePerUnit;

        const query = `
            UPDATE ingredientes
            SET precio_kg = $1, updated_at = NOW()
            WHERE id = $2 AND restaurante_id = $3
            RETURNING *
        `;
        const result = await this.pool.query(query, [newPrice, id, restaurantId]);

        return {
            ingredient: result.rows[0] ? new Ingredient(result.rows[0]) : null,
            oldPrice,
            newPrice
        };
    }

    /**
     * Actualiza stock de un ingrediente
     */
    async updateStock(id, quantity, restaurantId) {
        const query = `
            UPDATE ingredientes
            SET stock_actual = stock_actual + $1, updated_at = NOW()
            WHERE id = $2 AND restaurante_id = $3
            RETURNING *
        `;
        const result = await this.pool.query(query, [quantity, id, restaurantId]);
        return result.rows[0] ? new Ingredient(result.rows[0]) : null;
    }

    /**
     * Busca ingredientes con stock bajo
     */
    async findLowStock(restaurantId) {
        const query = `
            SELECT * FROM ingredientes
            WHERE restaurante_id = $1
              AND activo = true
              AND deleted_at IS NULL
              AND stock_actual < stock_minimo
            ORDER BY (stock_minimo - stock_actual) DESC
        `;
        const result = await this.pool.query(query, [restaurantId]);
        return result.rows.map(row => new Ingredient(row));
    }

    /**
     * Desmarca proveedores principales de un ingrediente
     */
    async clearPrimarySuppliers(ingredientId, client = null) {
        const db = client || this.pool;
        const query = `
            UPDATE ingrediente_proveedor
            SET es_principal = false
            WHERE ingrediente_id = $1
        `;
        await db.query(query, [ingredientId]);
    }

    /**
     * Añade un proveedor a un ingrediente
     */
    async addSupplier(ingredientId, supplierId, price, isPrimary, client = null) {
        const db = client || this.pool;
        const query = `
            INSERT INTO ingrediente_proveedor (ingrediente_id, proveedor_id, precio, es_principal)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (ingrediente_id, proveedor_id)
            DO UPDATE SET precio = $3, es_principal = $4
            RETURNING *
        `;
        const result = await db.query(query, [ingredientId, supplierId, price, isPrimary]);
        return result.rows[0];
    }
}

module.exports = IngredientRepository;
