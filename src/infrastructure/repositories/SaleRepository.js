/**
 * Repository: SaleRepository
 * Acceso a datos de ventas
 */

const Sale = require('../../domain/entities/Sale');

class SaleRepository {
    constructor(pool) {
        this.pool = pool;
    }

    /**
     * Busca venta por ID
     */
    async findById(id, restaurantId) {
        const query = `
            SELECT v.*, r.nombre as receta_nombre 
            FROM ventas v
            LEFT JOIN recetas r ON v.receta_id = r.id
            WHERE v.id = $1 AND v.restaurante_id = $2 AND v.deleted_at IS NULL
        `;
        const result = await this.pool.query(query, [id, restaurantId]);
        return result.rows[0] ? new Sale(result.rows[0]) : null;
    }

    /**
     * Busca todas las ventas activas
     */
    async findActive(restaurantId, limit = 100) {
        const query = `
            SELECT v.*, r.nombre as receta_nombre 
            FROM ventas v
            LEFT JOIN recetas r ON v.receta_id = r.id
            WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL
            ORDER BY v.fecha DESC
            LIMIT $2
        `;
        const result = await this.pool.query(query, [restaurantId, limit]);
        return result.rows.map(row => new Sale(row));
    }

    /**
     * Busca ventas por fecha específica
     */
    async findByDate(date, restaurantId) {
        const query = `
            SELECT v.*, r.nombre as receta_nombre 
            FROM ventas v
            LEFT JOIN recetas r ON v.receta_id = r.id
            WHERE v.restaurante_id = $1 
              AND v.fecha::date = $2
              AND v.deleted_at IS NULL
            ORDER BY v.fecha DESC
        `;
        const result = await this.pool.query(query, [restaurantId, date]);
        return result.rows.map(row => new Sale(row));
    }

    /**
     * Busca ventas en un rango de fechas
     */
    async findByDateRange(startDate, endDate, restaurantId) {
        const query = `
            SELECT v.*, r.nombre as receta_nombre 
            FROM ventas v
            LEFT JOIN recetas r ON v.receta_id = r.id
            WHERE v.restaurante_id = $1 
              AND v.fecha >= $2 
              AND v.fecha <= $3
              AND v.deleted_at IS NULL
            ORDER BY v.fecha DESC
        `;
        const result = await this.pool.query(query, [restaurantId, startDate, endDate]);
        return result.rows.map(row => new Sale(row));
    }

    /**
     * Busca ventas de una receta específica
     */
    async findByRecipe(recipeId, restaurantId) {
        const query = `
            SELECT v.*, r.nombre as receta_nombre 
            FROM ventas v
            LEFT JOIN recetas r ON v.receta_id = r.id
            WHERE v.receta_id = $1 
              AND v.restaurante_id = $2 
              AND v.deleted_at IS NULL
            ORDER BY v.fecha DESC
        `;
        const result = await this.pool.query(query, [recipeId, restaurantId]);
        return result.rows.map(row => new Sale(row));
    }

    /**
     * Crea una nueva venta
     */
    async create(saleData, restaurantId) {
        const sale = saleData instanceof Sale
            ? saleData
            : new Sale({ ...saleData, restaurante_id: restaurantId });

        const db = sale.toDB();

        const query = `
            INSERT INTO ventas 
                (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `;

        const result = await this.pool.query(query, [
            db.receta_id,
            db.cantidad,
            db.precio_unitario,
            db.total,
            db.fecha,
            restaurantId
        ]);

        return new Sale(result.rows[0]);
    }

    /**
     * Crea múltiples ventas en una transacción
     */
    async createBulk(salesData, restaurantId, client = null) {
        const db = client || this.pool;
        const results = [];

        for (const saleData of salesData) {
            const sale = new Sale({ ...saleData, restaurante_id: restaurantId });
            const dbData = sale.toDB();

            const query = `
                INSERT INTO ventas 
                    (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING *
            `;

            const result = await db.query(query, [
                dbData.receta_id,
                dbData.cantidad,
                dbData.precio_unitario,
                dbData.total,
                dbData.fecha,
                restaurantId
            ]);

            results.push(new Sale(result.rows[0]));
        }

        return results;
    }

    /**
     * Soft delete de una venta
     */
    async delete(id, restaurantId) {
        const query = `
            UPDATE ventas 
            SET deleted_at = NOW()
            WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL
            RETURNING *
        `;
        const result = await this.pool.query(query, [id, restaurantId]);
        return result.rows[0] ? new Sale(result.rows[0]) : null;
    }

    /**
     * Obtiene el total de ventas por día
     */
    async getTotalByDate(date, restaurantId) {
        const query = `
            SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count
            FROM ventas
            WHERE restaurante_id = $1 
              AND fecha::date = $2
              AND deleted_at IS NULL
        `;
        const result = await this.pool.query(query, [restaurantId, date]);
        return {
            total: parseFloat(result.rows[0].total),
            count: parseInt(result.rows[0].count)
        };
    }

    /**
     * Obtiene el total de ventas en un rango de fechas
     */
    async getTotalByDateRange(startDate, endDate, restaurantId) {
        const query = `
            SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count
            FROM ventas
            WHERE restaurante_id = $1 
              AND fecha >= $2 
              AND fecha <= $3
              AND deleted_at IS NULL
        `;
        const result = await this.pool.query(query, [restaurantId, startDate, endDate]);
        return {
            total: parseFloat(result.rows[0].total),
            count: parseInt(result.rows[0].count)
        };
    }

    /**
     * Obtiene las recetas más vendidas
     */
    async getTopRecipes(restaurantId, limit = 10, startDate = null, endDate = null) {
        let query = `
            SELECT r.id, r.nombre, SUM(v.cantidad) as total_vendido, SUM(v.total) as total_ingresos
            FROM ventas v
            JOIN recetas r ON v.receta_id = r.id
            WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL
        `;
        const params = [restaurantId];

        if (startDate && endDate) {
            query += ` AND v.fecha >= $2 AND v.fecha <= $3`;
            params.push(startDate, endDate);
        }

        query += ` GROUP BY r.id, r.nombre ORDER BY total_vendido DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const result = await this.pool.query(query, params);
        return result.rows;
    }
}

module.exports = SaleRepository;
