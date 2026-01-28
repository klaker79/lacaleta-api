/**
 * ============================================
 * services/index.js - Service Layer Export
 * ============================================
 *
 * Exporta todos los servicios de la aplicación.
 * Patrón Singleton para instancias únicas.
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const BaseService = require('./BaseService');
const IngredientService = require('./IngredientService');
const SaleService = require('./SaleService');
const AnalyticsService = require('./AnalyticsService');

// Singletons
const ingredientService = new IngredientService();
const saleService = new SaleService();
const analyticsService = new AnalyticsService();

module.exports = {
    BaseService,
    IngredientService,
    SaleService,
    AnalyticsService,
    // Instancias singleton
    ingredientService,
    saleService,
    analyticsService
};
