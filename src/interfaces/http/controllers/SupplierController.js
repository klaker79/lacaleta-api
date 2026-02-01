/**
 * Controller: SupplierController
 * Maneja requests HTTP para proveedores
 */

const SupplierRepository = require('../../../infrastructure/repositories/SupplierRepository');
const pool = require('../../../infrastructure/database/connection');

class SupplierController {
    /**
     * GET /api/suppliers
     * Lista todos los proveedores activos
     */
    static async list(req, res, next) {
        try {
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SupplierRepository(pool);

            const suppliers = await repo.findActive(restaurantId);

            // Retornar array directo para compatibilidad con frontend
            res.json(suppliers.map(s => s.toDTO()));
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/suppliers/:id
     * Obtiene un proveedor por ID
     */
    static async getById(req, res, next) {
        try {
            const { id } = req.params;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SupplierRepository(pool);

            const supplier = await repo.findById(id, restaurantId);

            if (!supplier) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Proveedor no encontrado' }
                });
            }

            res.json({
                success: true,
                data: supplier.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/suppliers
     * Crea un nuevo proveedor
     */
    static async create(req, res, next) {
        try {
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SupplierRepository(pool);

            const supplier = await repo.create(req.body, restaurantId);

            res.status(201).json({
                success: true,
                data: supplier.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * PUT /api/suppliers/:id
     * Actualiza un proveedor
     */
    static async update(req, res, next) {
        try {
            const { id } = req.params;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SupplierRepository(pool);

            const supplier = await repo.update(id, req.body, restaurantId);

            if (!supplier) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Proveedor no encontrado' }
                });
            }

            res.json({
                success: true,
                data: supplier.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * DELETE /api/suppliers/:id
     * Elimina un proveedor (soft delete)
     */
    static async delete(req, res, next) {
        try {
            const { id } = req.params;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SupplierRepository(pool);

            const deleted = await repo.delete(id, restaurantId);

            if (!deleted) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Proveedor no encontrado' }
                });
            }

            res.json({
                success: true,
                message: 'Proveedor eliminado'
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/suppliers/:id/ingredients
     * Obtiene ingredientes de un proveedor
     */
    static async getIngredients(req, res, next) {
        try {
            const { id } = req.params;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SupplierRepository(pool);

            const supplier = await repo.findById(id, restaurantId);

            if (!supplier) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Proveedor no encontrado' }
                });
            }

            res.json({
                success: true,
                data: {
                    supplierId: supplier.id,
                    supplierName: supplier.name,
                    ingredientIds: supplier.ingredientIds
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/suppliers/incomplete-contact
     * Lista proveedores sin información de contacto completa
     */
    static async getIncompleteContact(req, res, next) {
        try {
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SupplierRepository(pool);

            const suppliers = await repo.findWithIncompleteContact(restaurantId);

            res.json({
                success: true,
                data: suppliers.map(s => s.toDTO()),
                count: suppliers.length
            });
        } catch (error) {
            next(error);
        }
    }
}

module.exports = SupplierController;
