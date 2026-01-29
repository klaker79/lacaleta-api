/**
 * Repository: AlertRepository
 */

const Alert = require('../../domain/entities/Alert');

class AlertRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async create(alertData) {
        const query = `
            INSERT INTO alerts (
                restaurant_id, type, severity, status,
                title, message, entity_type, entity_id, data
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `;

        const result = await this.pool.query(query, [
            alertData.restaurantId,
            alertData.type,
            alertData.severity || 'warning',
            alertData.status || 'active',
            alertData.title,
            alertData.message,
            alertData.entityType,
            alertData.entityId,
            JSON.stringify(alertData.data || {})
        ]);

        return new Alert(result.rows[0]);
    }

    async findActive(restaurantId, limit = 50) {
        const query = `
            SELECT * FROM alerts
            WHERE restaurant_id = $1 AND status = 'active'
            ORDER BY
                CASE severity
                    WHEN 'critical' THEN 1
                    WHEN 'warning' THEN 2
                    ELSE 3
                END,
                created_at DESC
            LIMIT $2
        `;

        const result = await this.pool.query(query, [restaurantId, limit]);
        return result.rows.map(row => new Alert(row));
    }

    async findByEntity(entityType, entityId, restaurantId) {
        const query = `
            SELECT * FROM alerts
            WHERE restaurant_id = $1
              AND entity_type = $2
              AND entity_id = $3
              AND status = 'active'
        `;

        const result = await this.pool.query(query, [restaurantId, entityType, entityId]);
        return result.rows.map(row => new Alert(row));
    }

    async acknowledge(alertId, userId, restaurantId) {
        const query = `
            UPDATE alerts
            SET status = 'acknowledged',
                acknowledged_at = NOW(),
                acknowledged_by = $1
            WHERE id = $2 AND restaurant_id = $3
            RETURNING *
        `;

        const result = await this.pool.query(query, [userId, alertId, restaurantId]);
        return result.rows[0] ? new Alert(result.rows[0]) : null;
    }

    async resolve(alertId, restaurantId) {
        const query = `
            UPDATE alerts
            SET status = 'resolved', resolved_at = NOW()
            WHERE id = $1 AND restaurant_id = $2
            RETURNING *
        `;

        const result = await this.pool.query(query, [alertId, restaurantId]);
        return result.rows[0] ? new Alert(result.rows[0]) : null;
    }

    async resolveByEntity(entityType, entityId, alertType, restaurantId) {
        const query = `
            UPDATE alerts
            SET status = 'resolved', resolved_at = NOW()
            WHERE restaurant_id = $1
              AND entity_type = $2
              AND entity_id = $3
              AND type = $4
              AND status = 'active'
        `;

        await this.pool.query(query, [restaurantId, entityType, entityId, alertType]);
    }

    async getStats(restaurantId) {
        const query = `
            SELECT
                COUNT(*) FILTER (WHERE status = 'active') as active_count,
                COUNT(*) FILTER (WHERE status = 'active' AND severity = 'critical') as critical_count,
                COUNT(*) FILTER (WHERE status = 'active' AND severity = 'warning') as warning_count,
                COUNT(*) FILTER (WHERE status = 'acknowledged') as acknowledged_count
            FROM alerts
            WHERE restaurant_id = $1
        `;

        const result = await this.pool.query(query, [restaurantId]);
        return {
            activeCount: parseInt(result.rows[0].active_count) || 0,
            criticalCount: parseInt(result.rows[0].critical_count) || 0,
            warningCount: parseInt(result.rows[0].warning_count) || 0,
            acknowledgedCount: parseInt(result.rows[0].acknowledged_count) || 0
        };
    }
}

module.exports = AlertRepository;
