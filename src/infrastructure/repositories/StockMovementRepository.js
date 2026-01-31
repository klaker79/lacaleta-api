/**
 * Repository: StockMovementRepository
 * Acceso a datos de ajustes de inventario y mermas
 */

const StockMovement = require('../../domain/entities/StockMovement');

class StockMovementRepository {
    constructor(pool) {
        this.pool = pool;
    }

    /**
     * Busca ajuste por ID
     */
    async findAdjustmentById(id, restaurantId) {
        const query = `
            SELECT * FROM inventory_adjustments_v2
            WHERE id = $1 AND restaurante_id = $2
        `;
        const result = await this.pool.query(query, [id, restaurantId]);
        if (!result.rows[0]) return null;
        return new StockMovement({
            ...result.rows[0],
            type: StockMovement.TYPE.ADJUSTMENT
        });
    }

    /**
     * Busca merma por ID
     */
    async findWasteById(id, restaurantId) {
        const query = `
            SELECT * FROM mermas
            WHERE id = $1 AND restaurante_id = $2
        `;
        const result = await this.pool.query(query, [id, restaurantId]);
        if (!result.rows[0]) return null;
        return new StockMovement({
            ...result.rows[0],
            type: StockMovement.TYPE.WASTE
        });
    }

    /**
     * Busca todos los ajustes de un ingrediente
     */
    async findAdjustmentsByIngredient(ingredientId, restaurantId) {
        const query = `
            SELECT * FROM inventory_adjustments_v2
            WHERE ingrediente_id = $1 AND restaurante_id = $2
            ORDER BY fecha DESC
        `;
        const result = await this.pool.query(query, [ingredientId, restaurantId]);
        return result.rows.map(row => new StockMovement({
            ...row,
            type: StockMovement.TYPE.ADJUSTMENT
        }));
    }

    /**
     * Busca todas las mermas en un rango de fechas
     */
    async findWasteByDateRange(startDate, endDate, restaurantId) {
        const query = `
            SELECT * FROM mermas
            WHERE restaurante_id = $1 
              AND fecha >= $2 
              AND fecha <= $3
            ORDER BY fecha DESC
        `;
        const result = await this.pool.query(query, [restaurantId, startDate, endDate]);
        return result.rows.map(row => new StockMovement({
            ...row,
            type: StockMovement.TYPE.WASTE
        }));
    }

    /**
     * Busca mermas recientes
     */
    async findRecentWaste(restaurantId, limit = 50) {
        const query = `
            SELECT * FROM mermas
            WHERE restaurante_id = $1
            ORDER BY fecha DESC
            LIMIT $2
        `;
        const result = await this.pool.query(query, [restaurantId, limit]);
        return result.rows.map(row => new StockMovement({
            ...row,
            type: StockMovement.TYPE.WASTE
        }));
    }

    /**
     * Crea un ajuste de inventario
     */
    async createAdjustment(movementData, restaurantId) {
        const movement = movementData instanceof StockMovement
            ? movementData
            : new StockMovement({ ...movementData, restaurante_id: restaurantId });

        const db = movement.toAdjustmentDB();

        const query = `
            INSERT INTO inventory_adjustments_v2 
                (ingrediente_id, cantidad, motivo, notas, usuario_id, restaurante_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `;

        const result = await this.pool.query(query, [
            db.ingrediente_id,
            db.cantidad,
            db.motivo,
            db.notas,
            db.usuario_id,
            restaurantId
        ]);

        return new StockMovement({
            ...result.rows[0],
            type: StockMovement.TYPE.ADJUSTMENT
        });
    }

    /**
     * Crea una merma
     */
    async createWaste(movementData, restaurantId) {
        const movement = movementData instanceof StockMovement
            ? movementData
            : new StockMovement({ ...movementData, restaurante_id: restaurantId });

        const db = movement.toWasteDB();

        const query = `
            INSERT INTO mermas 
                (ingrediente_id, ingrediente_nombre, cantidad, unidad, valor_perdida, motivo, nota, responsable_id, restaurante_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `;

        const result = await this.pool.query(query, [
            db.ingrediente_id,
            db.ingrediente_nombre,
            db.cantidad,
            db.unidad,
            db.valor_perdida,
            db.motivo,
            db.nota,
            db.responsable_id,
            restaurantId
        ]);

        return new StockMovement({
            ...result.rows[0],
            type: StockMovement.TYPE.WASTE
        });
    }

    /**
     * Crea múltiples mermas en una transacción
     */
    async createWasteBulk(wasteDataArray, restaurantId, client = null) {
        const db = client || this.pool;
        const results = [];

        for (const wasteData of wasteDataArray) {
            const movement = new StockMovement({
                ...wasteData,
                restaurante_id: restaurantId,
                type: StockMovement.TYPE.WASTE
            });
            const dbData = movement.toWasteDB();

            const query = `
                INSERT INTO mermas 
                    (ingrediente_id, ingrediente_nombre, cantidad, unidad, valor_perdida, motivo, nota, responsable_id, restaurante_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING *
            `;

            const result = await db.query(query, [
                dbData.ingrediente_id,
                dbData.ingrediente_nombre,
                dbData.cantidad,
                dbData.unidad,
                dbData.valor_perdida,
                dbData.motivo,
                dbData.nota,
                dbData.responsable_id,
                restaurantId
            ]);

            results.push(new StockMovement({
                ...result.rows[0],
                type: StockMovement.TYPE.WASTE
            }));
        }

        return results;
    }

    /**
     * Obtiene el total de mermas en un período
     */
    async getWasteTotalByDateRange(startDate, endDate, restaurantId) {
        const query = `
            SELECT 
                COUNT(*) as count,
                COALESCE(SUM(cantidad), 0) as total_quantity,
                COALESCE(SUM(valor_perdida), 0) as total_value
            FROM mermas
            WHERE restaurante_id = $1 
              AND fecha >= $2 
              AND fecha <= $3
        `;
        const result = await this.pool.query(query, [restaurantId, startDate, endDate]);
        return {
            count: parseInt(result.rows[0].count),
            totalQuantity: parseFloat(result.rows[0].total_quantity),
            totalValue: parseFloat(result.rows[0].total_value)
        };
    }

    /**
     * Obtiene mermas agrupadas por motivo
     */
    async getWasteByReason(restaurantId, startDate = null, endDate = null) {
        let query = `
            SELECT 
                motivo,
                COUNT(*) as count,
                SUM(cantidad) as total_quantity,
                SUM(valor_perdida) as total_value
            FROM mermas
            WHERE restaurante_id = $1
        `;
        const params = [restaurantId];

        if (startDate && endDate) {
            query += ` AND fecha >= $2 AND fecha <= $3`;
            params.push(startDate, endDate);
        }

        query += ` GROUP BY motivo ORDER BY total_value DESC`;

        const result = await this.pool.query(query, params);
        return result.rows;
    }

    /**
     * Obtiene ingredientes con más mermas
     */
    async getTopWastedIngredients(restaurantId, limit = 10) {
        const query = `
            SELECT 
                ingrediente_id,
                ingrediente_nombre,
                COUNT(*) as waste_count,
                SUM(cantidad) as total_quantity,
                SUM(valor_perdida) as total_value
            FROM mermas
            WHERE restaurante_id = $1
            GROUP BY ingrediente_id, ingrediente_nombre
            ORDER BY total_value DESC
            LIMIT $2
        `;
        const result = await this.pool.query(query, [restaurantId, limit]);
        return result.rows;
    }
}

module.exports = StockMovementRepository;
