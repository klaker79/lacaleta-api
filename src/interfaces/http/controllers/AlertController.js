/**
 * Controller: AlertController
 */

const AlertService = require('../../../application/services/AlertService');

class AlertController {
    /**
     * GET /api/v2/alerts
     */
    static async list(req, res, next) {
        try {
            const { restaurante_id } = req.user;
            const alertService = new AlertService();

            const alerts = await alertService.getActiveAlerts(restaurante_id);

            res.json({
                success: true,
                data: alerts.map(a => a.toDTO()),
                count: alerts.length
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v2/alerts/stats
     */
    static async getStats(req, res, next) {
        try {
            const { restaurante_id } = req.user;
            const alertService = new AlertService();

            const stats = await alertService.getAlertStats(restaurante_id);

            res.json({
                success: true,
                data: stats
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v2/alerts/:id/acknowledge
     */
    static async acknowledge(req, res, next) {
        try {
            const { id } = req.params;
            const { restaurante_id, userId } = req.user;
            const alertService = new AlertService();

            const alert = await alertService.acknowledgeAlert(id, userId, restaurante_id);

            if (!alert) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Alerta no encontrada' }
                });
            }

            res.json({
                success: true,
                data: alert.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v2/alerts/:id/resolve
     */
    static async resolve(req, res, next) {
        try {
            const { id } = req.params;
            const { restaurante_id } = req.user;
            const alertService = new AlertService();

            const alert = await alertService.resolveAlert(id, restaurante_id);

            if (!alert) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Alerta no encontrada' }
                });
            }

            res.json({
                success: true,
                data: alert.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }
}

module.exports = AlertController;
