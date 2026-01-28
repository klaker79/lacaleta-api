/**
 * ============================================
 * services/SaleService.js
 * ============================================
 *
 * Lógica de negocio para ventas.
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const BaseService = require('./BaseService');
const { log } = require('../utils/logger');
const { validateCantidad } = require('../utils/validators');

class SaleService extends BaseService {
    constructor() {
        super('ventas');
    }

    /**
     * Registrar venta con descuento de stock automático
     */
    async registerSale(saleData, restauranteId) {
        return this.withTransaction(async (client) => {
            const { receta_id, cantidad, precio_unitario, total, fecha } = saleData;

            // 1. Insertar venta
            const saleResult = await client.query(
                `INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [receta_id, cantidad, precio_unitario, total, fecha || new Date(), restauranteId]
            );

            // 2. Obtener ingredientes de la receta
            const recetaResult = await client.query(
                'SELECT ingredientes FROM recetas WHERE id = $1 AND restaurante_id = $2',
                [receta_id, restauranteId]
            );

            if (recetaResult.rows.length > 0) {
                const ingredientes = recetaResult.rows[0].ingredientes || [];

                // 3. Descontar stock
                for (const ing of ingredientes) {
                    const consumo = (ing.cantidad || 0) * cantidad;
                    await client.query(
                        `UPDATE ingredientes 
                         SET stock_actual = GREATEST(0, stock_actual - $1),
                             ultima_actualizacion_stock = NOW()
                         WHERE id = $2 AND restaurante_id = $3`,
                        [consumo, ing.ingredienteId, restauranteId]
                    );
                }
            }

            log('info', 'Venta registrada', { receta_id, cantidad, total });
            return saleResult.rows[0];
        });
    }

    /**
     * Registrar ventas en bulk
     */
    async registerBulk(ventas, restauranteId) {
        const results = { insertados: 0, errores: [] };

        for (const venta of ventas) {
            try {
                await this.registerSale(venta, restauranteId);
                results.insertados++;
            } catch (err) {
                results.errores.push({ venta, error: err.message });
            }
        }

        return results;
    }

    /**
     * Obtener ventas por rango de fechas
     */
    async getByDateRange(desde, hasta, restauranteId) {
        return this.query(
            `SELECT v.*, r.nombre as receta_nombre, r.categoria
             FROM ventas v
             JOIN recetas r ON v.receta_id = r.id
             WHERE v.fecha BETWEEN $1 AND $2 AND v.restaurante_id = $3 AND v.deleted_at IS NULL
             ORDER BY v.fecha DESC`,
            [desde, hasta, restauranteId]
        );
    }

    /**
     * Resumen diario
     */
    async getDailySummary(fecha, restauranteId) {
        return this.query(
            `SELECT 
                SUM(total) as total_ventas,
                SUM(cantidad) as unidades_vendidas,
                COUNT(*) as num_transacciones
             FROM ventas
             WHERE DATE(fecha) = $1 AND restaurante_id = $2 AND deleted_at IS NULL`,
            [fecha, restauranteId]
        );
    }
}

module.exports = SaleService;
