/**
 * ============================================
 * services/IngredientService.js
 * ============================================
 *
 * Lógica de negocio para ingredientes.
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const BaseService = require('./BaseService');
const { log } = require('../utils/logger');
const { validatePrecio, validateCantidad } = require('../utils/validators');

class IngredientService extends BaseService {
    constructor() {
        super('ingredientes');
    }

    /**
     * Obtener todos los ingredientes activos
     */
    async getAll(restauranteId, includeInactive = false) {
        const activeClause = includeInactive ? '' : 'AND activo = true';
        return this.query(
            `SELECT i.*, 
                    COALESCE(json_agg(json_build_object('proveedor_id', ip.proveedor_id, 'nombre', p.nombre)) 
                             FILTER (WHERE ip.proveedor_id IS NOT NULL), '[]') as proveedores
             FROM ingredientes i
             LEFT JOIN ingredientes_proveedores ip ON i.id = ip.ingrediente_id
             LEFT JOIN proveedores p ON ip.proveedor_id = p.id
             WHERE i.restaurante_id = $1 ${activeClause}
             GROUP BY i.id
             ORDER BY i.nombre`,
            [restauranteId]
        );
    }

    /**
     * Crear ingrediente con validación
     */
    async create(data, restauranteId) {
        const cleanData = {
            nombre: data.nombre,
            familia: data.familia || 'otros',
            unidad: data.unidad || 'ud',
            precio: validatePrecio(data.precio),
            stock_actual: validateCantidad(data.stock_actual || 0),
            stock_minimo: validateCantidad(data.stock_minimo || 0),
            cantidad_por_formato: validateCantidad(data.cantidad_por_formato || 1),
            proveedor_id: data.proveedor_id || null,
            activo: true
        };

        return super.create(cleanData, restauranteId);
    }

    /**
     * Actualizar stock
     */
    async updateStock(id, cantidad, operacion, restauranteId) {
        const op = operacion === 'sumar' ? '+' : '-';
        const result = await this.query(
            `UPDATE ingredientes 
             SET stock_actual = GREATEST(0, stock_actual ${op} $1),
                 ultima_actualizacion_stock = NOW()
             WHERE id = $2 AND restaurante_id = $3
             RETURNING *`,
            [validateCantidad(cantidad), id, restauranteId]
        );
        return result[0];
    }

    /**
     * Obtener alertas de stock bajo
     */
    async getLowStockAlerts(restauranteId) {
        return this.query(
            `SELECT id, nombre, stock_actual, stock_minimo, unidad
             FROM ingredientes
             WHERE restaurante_id = $1 AND activo = true
               AND stock_actual <= stock_minimo
             ORDER BY (stock_actual - stock_minimo)`,
            [restauranteId]
        );
    }

    /**
     * Toggle activo/inactivo
     */
    async toggleActive(id, restauranteId) {
        const result = await this.query(
            `UPDATE ingredientes SET activo = NOT activo WHERE id = $1 AND restaurante_id = $2 RETURNING *`,
            [id, restauranteId]
        );
        return result[0];
    }
}

module.exports = IngredientService;
