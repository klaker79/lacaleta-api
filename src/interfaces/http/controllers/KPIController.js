/**
 * Controller: KPIController
 */

const KPIService = require('../../../application/services/KPIService');

class KPIController {
    /**
     * GET /api/v2/kpis/daily
     */
    static async getDaily(req, res, next) {
        try {
            const { restaurante_id } = req.user;
            const { date } = req.query;

            const kpiService = new KPIService();
            const kpis = await kpiService.getDailyKPIs(
                restaurante_id,
                date ? new Date(date) : new Date()
            );

            res.json({ success: true, data: kpis });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v2/kpis/monthly
     */
    static async getMonthly(req, res, next) {
        try {
            const { restaurante_id } = req.user;
            const { year, month } = req.query;

            const now = new Date();
            const kpiService = new KPIService();
            const kpis = await kpiService.getMonthlyKPIs(
                restaurante_id,
                parseInt(year) || now.getFullYear(),
                parseInt(month) || now.getMonth() + 1
            );

            res.json({ success: true, data: kpis });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v2/kpis/comparison
     */
    static async getComparison(req, res, next) {
        try {
            const { restaurante_id } = req.user;
            const { months } = req.query;

            const kpiService = new KPIService();
            const data = await kpiService.getMonthlyComparison(
                restaurante_id,
                parseInt(months) || 6
            );

            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v2/kpis/top-recipes
     */
    static async getTopRecipes(req, res, next) {
        try {
            const { restaurante_id } = req.user;
            const { limit } = req.query;

            const kpiService = new KPIService();
            const data = await kpiService.getTopRecipesByMargin(
                restaurante_id,
                parseInt(limit) || 10
            );

            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v2/kpis/daily-range
     * Obtiene KPIs de los últimos N días
     */
    static async getDailyRange(req, res, next) {
        try {
            const { restaurante_id } = req.user;
            const { days = 7 } = req.query;

            const kpiService = new KPIService();
            const data = await kpiService.getDailyRange(
                restaurante_id,
                parseInt(days)
            );

            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }
}

module.exports = KPIController;
