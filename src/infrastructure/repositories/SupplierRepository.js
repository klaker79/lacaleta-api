/**
 * Repository: SupplierRepository
 * Acceso a datos de proveedores
 */

const Supplier = require('../../domain/entities/Supplier');

class SupplierRepository {
    constructor(pool) {
        this.pool = pool;
    }

    /**
     * Busca proveedor por ID
     */
    async findById(id, restaurantId) {
        const query = `
            SELECT * FROM proveedores
            WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL
        `;
        const result = await this.pool.query(query, [id, restaurantId]);
        return result.rows[0] ? new Supplier(result.rows[0]) : null;
    }

    /**
     * Busca todos los proveedores activos
     * ⚡ PERF: LEFT JOIN + GROUP BY en vez de subconsulta correlacionada
     */
    async findActive(restaurantId) {
        const query = `
            SELECT p.*, 
                   COALESCE(array_agg(ip.ingrediente_id) FILTER (WHERE ip.ingrediente_id IS NOT NULL), ARRAY[]::int[]) as ingredientes_reales
            FROM proveedores p
            LEFT JOIN ingredientes_proveedores ip ON ip.proveedor_id = p.id
            WHERE p.restaurante_id = $1 AND p.deleted_at IS NULL
            GROUP BY p.id
            ORDER BY p.nombre
        `;
        const result = await this.pool.query(query, [restaurantId]);
        return result.rows.map(row => {
            // Usar ingredientes_reales (de la tabla relacional) en vez de la columna ingredientes
            row.ingredientes = row.ingredientes_reales || row.ingredientes || [];
            return new Supplier(row);
        });
    }

    /**
     * Busca proveedores por IDs
     */
    async findByIds(ids, restaurantId) {
        if (!ids.length) return [];

        const query = `
            SELECT * FROM proveedores
            WHERE id = ANY($1) AND restaurante_id = $2 AND deleted_at IS NULL
        `;
        const result = await this.pool.query(query, [ids, restaurantId]);
        return result.rows.map(row => new Supplier(row));
    }

    /**
     * Busca proveedores que suministran un ingrediente específico
     */
    async findByIngredient(ingredientId, restaurantId) {
        const query = `
            SELECT p.* FROM proveedores p
            JOIN ingredientes_proveedores ip ON p.id = ip.proveedor_id
            WHERE ip.ingrediente_id = $1 
              AND p.restaurante_id = $2 
              AND p.deleted_at IS NULL
            ORDER BY ip.es_proveedor_principal DESC, p.nombre
        `;
        const result = await this.pool.query(query, [ingredientId, restaurantId]);
        return result.rows.map(row => new Supplier(row));
    }

    /**
     * Crea un nuevo proveedor
     */
    async create(supplierData, restaurantId) {
        const supplier = supplierData instanceof Supplier
            ? supplierData
            : new Supplier({ ...supplierData, restaurante_id: restaurantId });

        const db = supplier.toDB();

        const query = `
            INSERT INTO proveedores 
                (nombre, contacto, telefono, email, direccion, notas, codigo, cif, ingredientes, restaurante_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
        `;

        const result = await this.pool.query(query, [
            db.nombre,
            db.contacto,
            db.telefono,
            db.email,
            db.direccion,
            db.notas,
            db.codigo,
            db.cif,
            db.ingredientes,
            restaurantId
        ]);

        return new Supplier(result.rows[0]);
    }

    /**
     * Actualiza un proveedor
     */
    async update(id, supplierData, restaurantId) {
        const supplier = supplierData instanceof Supplier
            ? supplierData
            : new Supplier({ ...supplierData, restaurante_id: restaurantId });

        const db = supplier.toDB();

        const query = `
            UPDATE proveedores 
            SET nombre = $1, contacto = $2, telefono = $3, email = $4, 
                direccion = $5, notas = $6, codigo = $7, cif = $8, 
                ingredientes = $9, fecha_actualizacion = NOW()
            WHERE id = $10 AND restaurante_id = $11 AND deleted_at IS NULL
            RETURNING *
        `;

        const result = await this.pool.query(query, [
            db.nombre,
            db.contacto,
            db.telefono,
            db.email,
            db.direccion,
            db.notas,
            db.codigo,
            db.cif,
            db.ingredientes,
            id,
            restaurantId
        ]);

        return result.rows[0] ? new Supplier(result.rows[0]) : null;
    }

    /**
     * Soft delete de un proveedor
     */
    async delete(id, restaurantId) {
        const query = `
            UPDATE proveedores 
            SET deleted_at = NOW()
            WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL
            RETURNING *
        `;
        const result = await this.pool.query(query, [id, restaurantId]);
        return result.rows[0] ? new Supplier(result.rows[0]) : null;
    }

    /**
     * Busca proveedores sin contacto completo
     */
    async findWithIncompleteContact(restaurantId) {
        const query = `
            SELECT * FROM proveedores
            WHERE restaurante_id = $1 
              AND deleted_at IS NULL
              AND (telefono IS NULL OR telefono = '' OR email IS NULL OR email = '')
            ORDER BY nombre
        `;
        const result = await this.pool.query(query, [restaurantId]);
        return result.rows.map(row => new Supplier(row));
    }
}

module.exports = SupplierRepository;
