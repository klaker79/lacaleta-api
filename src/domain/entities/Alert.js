/**
 * Entidad: Alert
 * Representa una alerta del sistema
 */

class Alert {
    static TYPES = {
        LOW_MARGIN: 'low_margin',
        HIGH_FOOD_COST: 'high_food_cost',
        LOW_STOCK: 'low_stock',
        PRICE_INCREASE: 'price_increase',
        COST_DEVIATION: 'cost_deviation'
    };

    static SEVERITIES = {
        INFO: 'info',
        WARNING: 'warning',
        CRITICAL: 'critical'
    };

    static STATUS = {
        ACTIVE: 'active',
        ACKNOWLEDGED: 'acknowledged',
        RESOLVED: 'resolved'
    };

    constructor(data) {
        this.id = data.id;
        this.restaurantId = data.restaurant_id || data.restaurantId;
        this.type = data.type;
        this.severity = data.severity || Alert.SEVERITIES.WARNING;
        this.status = data.status || Alert.STATUS.ACTIVE;
        this.title = data.title;
        this.message = data.message;
        this.entityType = data.entity_type || data.entityType;
        this.entityId = data.entity_id || data.entityId;
        this.data = data.data || {};
        this.createdAt = data.created_at || data.createdAt || new Date();
        this.acknowledgedAt = data.acknowledged_at || data.acknowledgedAt;
        this.resolvedAt = data.resolved_at || data.resolvedAt;
    }

    acknowledge(userId) {
        this.status = Alert.STATUS.ACKNOWLEDGED;
        this.acknowledgedAt = new Date();
        this.acknowledgedBy = userId;
    }

    resolve() {
        this.status = Alert.STATUS.RESOLVED;
        this.resolvedAt = new Date();
    }

    isActive() {
        return this.status === Alert.STATUS.ACTIVE;
    }

    toDTO() {
        return {
            id: this.id,
            type: this.type,
            severity: this.severity,
            status: this.status,
            title: this.title,
            message: this.message,
            entityType: this.entityType,
            entityId: this.entityId,
            data: this.data,
            createdAt: this.createdAt,
            isActive: this.isActive()
        };
    }
}

module.exports = Alert;
