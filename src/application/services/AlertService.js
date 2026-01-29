/**
 * Application Service: AlertService
 * Gestiona alertas del sistema
 */

const Alert = require('../../domain/entities/Alert');
const AlertRepository = require('../../infrastructure/repositories/AlertRepository');

class AlertService {
    constructor(dependencies = {}) {
        this.pool = dependencies.pool || require('../../infrastructure/database/connection');
        this.alertRepo = new AlertRepository(this.pool);

        // Umbrales configurables
        this.thresholds = {
            marginLow: 60,           // % mínimo de margen
            foodCostHigh: 35,        // % máximo de food cost
            priceIncreaseAlert: 10,  // % de incremento de precio para alertar
            stockDaysWarning: 3      // días de stock para alertar
        };
    }

    /**
     * Verifica y crea alertas basadas en coste de receta
     */
    async checkRecipeCostAlerts(recipeId, restaurantId, breakdown, recipeName) {
        const alerts = [];

        // Verificar margen bajo
        if (breakdown.marginPercentage < this.thresholds.marginLow) {
            const existing = await this.alertRepo.findByEntity('recipe', recipeId, restaurantId);
            const hasMarginAlert = existing.some(a => a.type === Alert.TYPES.LOW_MARGIN);

            if (!hasMarginAlert) {
                const alert = await this.alertRepo.create({
                    restaurantId,
                    type: Alert.TYPES.LOW_MARGIN,
                    severity: breakdown.marginPercentage < 50 ? 'critical' : 'warning',
                    title: `Margen bajo en "${recipeName}"`,
                    message: `El margen ha bajado a ${breakdown.marginPercentage.toFixed(1)}% (mínimo: ${this.thresholds.marginLow}%)`,
                    entityType: 'recipe',
                    entityId: recipeId,
                    data: {
                        currentMargin: breakdown.marginPercentage,
                        threshold: this.thresholds.marginLow,
                        totalCost: breakdown.totalCost
                    }
                });
                alerts.push(alert);
            }
        } else {
            await this.alertRepo.resolveByEntity('recipe', recipeId, Alert.TYPES.LOW_MARGIN, restaurantId);
        }

        // Verificar food cost alto
        if (breakdown.foodCostPercentage > this.thresholds.foodCostHigh) {
            const existing = await this.alertRepo.findByEntity('recipe', recipeId, restaurantId);
            const hasFoodCostAlert = existing.some(a => a.type === Alert.TYPES.HIGH_FOOD_COST);

            if (!hasFoodCostAlert) {
                const alert = await this.alertRepo.create({
                    restaurantId,
                    type: Alert.TYPES.HIGH_FOOD_COST,
                    severity: 'warning',
                    title: `Food cost alto en "${recipeName}"`,
                    message: `El food cost es ${breakdown.foodCostPercentage.toFixed(1)}% (máximo: ${this.thresholds.foodCostHigh}%)`,
                    entityType: 'recipe',
                    entityId: recipeId,
                    data: {
                        currentFoodCost: breakdown.foodCostPercentage,
                        threshold: this.thresholds.foodCostHigh
                    }
                });
                alerts.push(alert);
            }
        } else {
            await this.alertRepo.resolveByEntity('recipe', recipeId, Alert.TYPES.HIGH_FOOD_COST, restaurantId);
        }

        return alerts;
    }

    /**
     * Verifica alertas de incremento de precio de ingrediente
     */
    async checkPriceIncreaseAlert(ingredientId, restaurantId, ingredientName, oldPrice, newPrice) {
        if (oldPrice <= 0) return null;

        const increasePercent = ((newPrice - oldPrice) / oldPrice) * 100;

        if (increasePercent >= this.thresholds.priceIncreaseAlert) {
            return await this.alertRepo.create({
                restaurantId,
                type: Alert.TYPES.PRICE_INCREASE,
                severity: increasePercent >= 20 ? 'critical' : 'warning',
                title: `Incremento de precio: "${ingredientName}"`,
                message: `El precio ha subido un ${increasePercent.toFixed(1)}% (de ${oldPrice.toFixed(2)}€ a ${newPrice.toFixed(2)}€)`,
                entityType: 'ingredient',
                entityId: ingredientId,
                data: { oldPrice, newPrice, increasePercent }
            });
        }

        return null;
    }

    /**
     * Verifica alertas de stock bajo
     */
    async checkLowStockAlert(ingredientId, restaurantId, ingredientName, currentStock, minStock) {
        if (currentStock >= minStock) {
            await this.alertRepo.resolveByEntity('ingredient', ingredientId, Alert.TYPES.LOW_STOCK, restaurantId);
            return null;
        }

        const existing = await this.alertRepo.findByEntity('ingredient', ingredientId, restaurantId);
        const hasStockAlert = existing.some(a => a.type === Alert.TYPES.LOW_STOCK);

        if (hasStockAlert) return null;

        return await this.alertRepo.create({
            restaurantId,
            type: Alert.TYPES.LOW_STOCK,
            severity: currentStock <= 0 ? 'critical' : 'warning',
            title: `Stock bajo: "${ingredientName}"`,
            message: `Stock actual: ${currentStock.toFixed(2)} (mínimo: ${minStock.toFixed(2)})`,
            entityType: 'ingredient',
            entityId: ingredientId,
            data: { currentStock, minStock, deficit: minStock - currentStock }
        });
    }

    async getActiveAlerts(restaurantId) {
        return await this.alertRepo.findActive(restaurantId);
    }

    async getAlertStats(restaurantId) {
        return await this.alertRepo.getStats(restaurantId);
    }

    async acknowledgeAlert(alertId, userId, restaurantId) {
        return await this.alertRepo.acknowledge(alertId, userId, restaurantId);
    }

    async resolveAlert(alertId, restaurantId) {
        return await this.alertRepo.resolve(alertId, restaurantId);
    }

    /**
     * Obtiene historial de alertas con filtros
     */
    async getAlertHistory(restaurantId, options = {}) {
        const { status, type, limit = 50, offset = 0 } = options;

        let query = `
            SELECT * FROM alerts
            WHERE restaurant_id = $1
        `;
        const params = [restaurantId];
        let paramIndex = 2;

        if (status) {
            query += ` AND status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (type) {
            query += ` AND type = $${paramIndex}`;
            params.push(type);
            paramIndex++;
        }

        query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const result = await this.pool.query(query, params);

        const Alert = require('../domain/entities/Alert');
        return result.rows.map(row => new Alert(row));
    }
}

module.exports = AlertService;
