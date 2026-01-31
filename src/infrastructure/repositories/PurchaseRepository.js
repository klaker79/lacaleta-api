/**
 * Repository: PurchaseRepository
 * Acceso a datos de pedidos a proveedores
 */

const Purchase = require('../../domain/entities/Purchase');

class PurchaseRepository {
    constructor(pool) {
        this.pool = pool;
    }

    /**
     * Busca pedido por ID
     */
    async findById(id, restaurantId) {
        const query = `
            SELECT * FROM pedidos
            WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL
        `;
        const result = await this.pool.query(query, [id, restaurantId]);
        return result.rows[0] ? new Purchase(result.rows[0]) : null;
    }

    /**
     * Busca todos los pedidos activos ordenados por fecha
     */
    async findActive(restaurantId) {
        const query = `
            SELECT * FROM pedidos
            WHERE restaurante_id = $1 AND deleted_at IS NULL
            ORDER BY fecha DESC
        `;
        const result = await this.pool.query(query, [restaurantId]);
        return result.rows.map(row => new Purchase(row));
    }

    /**
     * Busca pedidos por estado
     */
    async findByStatus(status, restaurantId) {
        const query = `
            SELECT * FROM pedidos
            WHERE restaurante_id = $1 
              AND estado = $2 
              AND deleted_at IS NULL
            ORDER BY fecha DESC
        `;
        const result = await this.pool.query(query, [restaurantId, status]);
        return result.rows.map(row => new Purchase(row));
    }

    /**
     * Busca pedidos pendientes
     */
    async findPending(restaurantId) {
        return this.findByStatus(Purchase.STATUS.PENDING, restaurantId);
    }

    /**
     * Busca pedidos de un proveedor específico
     */
    async findBySupplier(supplierId, restaurantId) {
        const query = `
            SELECT * FROM pedidos
            WHERE proveedor_id = $1 
              AND restaurante_id = $2 
              AND deleted_at IS NULL
            ORDER BY fecha DESC
        `;
        const result = await this.pool.query(query, [supplierId, restaurantId]);
        return result.rows.map(row => new Purchase(row));
    }

    /**
     * Busca pedidos en un rango de fechas
     */
    async findByDateRange(startDate, endDate, restaurantId) {
        const query = `
            SELECT * FROM pedidos
            WHERE restaurante_id = $1 
              AND fecha >= $2 
              AND fecha <= $3
              AND deleted_at IS NULL
            ORDER BY fecha DESC
        `;
        const result = await this.pool.query(query, [restaurantId, startDate, endDate]);
        return result.rows.map(row => new Purchase(row));
    }

    /**
     * Crea un nuevo pedido
     */
    async create(purchaseData, restaurantId) {
        const purchase = purchaseData instanceof Purchase
            ? purchaseData
            : new Purchase({ ...purchaseData, restaurante_id: restaurantId });

        const db = purchase.toDB();

        const query = `
            INSERT INTO pedidos 
                (proveedor_id, fecha, ingredientes, total, estado, restaurante_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `;

        const result = await this.pool.query(query, [
            db.proveedor_id,
            db.fecha,
            db.ingredientes,
            db.total,
            db.estado,
            restaurantId
        ]);

        return new Purchase(result.rows[0]);
    }

    /**
     * Actualiza un pedido
     */
    async update(id, purchaseData, restaurantId) {
        const purchase = purchaseData instanceof Purchase
            ? purchaseData
            : new Purchase({ ...purchaseData, restaurante_id: restaurantId });

        const db = purchase.toDB();

        const query = `
            UPDATE pedidos 
            SET proveedor_id = $1, fecha = $2, ingredientes = $3, 
                total = $4, estado = $5
            WHERE id = $6 AND restaurante_id = $7 AND deleted_at IS NULL
            RETURNING *
        `;

        const result = await this.pool.query(query, [
            db.proveedor_id,
            db.fecha,
            db.ingredientes,
            db.total,
            db.estado,
            id,
            restaurantId
        ]);

        return result.rows[0] ? new Purchase(result.rows[0]) : null;
    }

    /**
     * Marca un pedido como recibido
     */
    async markAsReceived(id, totalReceived, restaurantId) {
        const query = `
            UPDATE pedidos 
            SET estado = $1, fecha_recepcion = NOW(), total_recibido = $2
            WHERE id = $3 AND restaurante_id = $4 AND deleted_at IS NULL
            RETURNING *
        `;

        const result = await this.pool.query(query, [
            Purchase.STATUS.RECEIVED,
            totalReceived,
            id,
            restaurantId
        ]);

        return result.rows[0] ? new Purchase(result.rows[0]) : null;
    }

    /**
     * Soft delete de un pedido
     */
    async delete(id, restaurantId) {
        const query = `
            UPDATE pedidos 
            SET deleted_at = NOW()
            WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL
            RETURNING *
        `;
        const result = await this.pool.query(query, [id, restaurantId]);
        return result.rows[0] ? new Purchase(result.rows[0]) : null;
    }

    /**
     * Calcula el total de pedidos en un período
     */
    async getTotalByDateRange(startDate, endDate, restaurantId) {
        const query = `
            SELECT COALESCE(SUM(total), 0) as total
            FROM pedidos
            WHERE restaurante_id = $1 
              AND fecha >= $2 
              AND fecha <= $3
              AND deleted_at IS NULL
        `;
        const result = await this.pool.query(query, [restaurantId, startDate, endDate]);
        return parseFloat(result.rows[0].total);
    }
}

module.exports = PurchaseRepository;
