/**
 * Application Service: InventoryService
 * Gestiona movimientos de stock
 */

const AlertService = require('./AlertService');

class InventoryService {
    constructor(dependencies = {}) {
        this.pool = dependencies.pool || require('../../infrastructure/database/connection');
        this.alertService = new AlertService(dependencies);
    }

    /**
     * Descuenta stock basado en una venta
     * @param {number} restaurantId
     * @param {Array} items - [{ recipeId, quantity, saleId }]
     */
    async deductStockFromSale(restaurantId, items) {
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            const movements = [];

            for (const item of items) {
                // Obtener ingredientes de la receta
                const recipeQuery = `
                    SELECT ingredientes FROM recetas
                    WHERE id = $1 AND restaurante_id = $2
                `;
                const recipeResult = await client.query(recipeQuery, [item.recipeId, restaurantId]);

                if (recipeResult.rows.length === 0) continue;

                let ingredientes = recipeResult.rows[0].ingredientes;
                if (typeof ingredientes === 'string') {
                    ingredientes = JSON.parse(ingredientes);
                }

                // Descontar cada ingrediente
                for (const ing of ingredientes || []) {
                    const quantityToDeduct = (ing.cantidad / 1000) * item.quantity; // g a kg

                    // Actualizar stock
                    const updateQuery = `
                        UPDATE ingredientes
                        SET stock_actual = GREATEST(0, stock_actual - $1),
                            ultima_actualizacion_stock = NOW()
                        WHERE id = $2 AND restaurante_id = $3
                        RETURNING id, nombre, stock_actual, stock_minimo
                    `;
                    const updateResult = await client.query(updateQuery, [
                        quantityToDeduct,
                        ing.ingrediente_id,
                        restaurantId
                    ]);

                    if (updateResult.rows.length > 0) {
                        const updated = updateResult.rows[0];

                        // Registrar movimiento
                        try {
                            await client.query(`
                                INSERT INTO stock_movements (
                                    restaurant_id, ingredient_id, movement_type,
                                    quantity, reference_type, reference_id
                                ) VALUES ($1, $2, 'sale', $3, 'sale', $4)
                            `, [restaurantId, ing.ingrediente_id, -quantityToDeduct, item.saleId]);
                        } catch (e) {
                            // Tabla puede no existir aún
                            console.warn('[InventoryService] stock_movements no existe:', e.message);
                        }

                        movements.push({
                            ingredientId: ing.ingrediente_id,
                            ingredientName: updated.nombre,
                            quantityDeducted: quantityToDeduct,
                            newStock: parseFloat(updated.stock_actual)
                        });

                        // Verificar stock bajo
                        const currentStock = parseFloat(updated.stock_actual);
                        const minStock = parseFloat(updated.stock_minimo) || 0;

                        if (currentStock < minStock) {
                            await this.alertService.checkLowStockAlert(
                                ing.ingrediente_id,
                                restaurantId,
                                updated.nombre,
                                currentStock,
                                minStock
                            );
                        }
                    }
                }
            }

            await client.query('COMMIT');

            return {
                success: true,
                movements,
                totalMovements: movements.length
            };

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[InventoryService] Error deducting stock:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Añade stock desde una compra recibida
     */
    async addStockFromPurchase(restaurantId, purchaseId, items) {
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            const movements = [];

            for (const item of items) {
                const updateQuery = `
                    UPDATE ingredientes
                    SET stock_actual = stock_actual + $1,
                        ultima_actualizacion_stock = NOW()
                    WHERE id = $2 AND restaurante_id = $3
                    RETURNING id, nombre, stock_actual, stock_minimo
                `;
                const updateResult = await client.query(updateQuery, [
                    item.quantity,
                    item.ingredientId,
                    restaurantId
                ]);

                if (updateResult.rows.length > 0) {
                    const updated = updateResult.rows[0];

                    try {
                        await client.query(`
                            INSERT INTO stock_movements (
                                restaurant_id, ingredient_id, movement_type,
                                quantity, reference_type, reference_id
                            ) VALUES ($1, $2, 'purchase', $3, 'purchase', $4)
                        `, [restaurantId, item.ingredientId, item.quantity, purchaseId]);
                    } catch (e) {
                        console.warn('[InventoryService] stock_movements no existe');
                    }

                    movements.push({
                        ingredientId: item.ingredientId,
                        ingredientName: updated.nombre,
                        quantityAdded: item.quantity,
                        newStock: parseFloat(updated.stock_actual)
                    });

                    // Resolver alertas si stock OK
                    const currentStock = parseFloat(updated.stock_actual);
                    const minStock = parseFloat(updated.stock_minimo) || 0;

                    if (currentStock >= minStock) {
                        await this.alertService.checkLowStockAlert(
                            item.ingredientId,
                            restaurantId,
                            updated.nombre,
                            currentStock,
                            minStock
                        );
                    }
                }
            }

            await client.query('COMMIT');
            return { success: true, movements };

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Obtiene ingredientes con stock bajo
     */
    async getLowStockIngredients(restaurantId) {
        const query = `
            SELECT
                id, nombre, stock_actual, stock_minimo, unidad,
                (stock_minimo - stock_actual) as deficit
            FROM ingredientes
            WHERE restaurante_id = $1
              AND activo = true
              AND stock_actual < stock_minimo
            ORDER BY deficit DESC
        `;

        const result = await this.pool.query(query, [restaurantId]);
        return result.rows;
    }
}

module.exports = InventoryService;
