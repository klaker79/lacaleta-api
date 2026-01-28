/**
 * ============================================
 * services/BaseService.js - Servicio Base
 * ============================================
 *
 * Clase base con métodos comunes para todos los servicios.
 * Patrón Repository + Unit of Work.
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const { pool } = require('../config/database');
const { log } = require('../utils/logger');

class BaseService {
    constructor(tableName) {
        this.tableName = tableName;
        this.pool = pool;
    }

    /**
     * Ejecuta query con manejo de errores estándar
     */
    async query(sql, params = []) {
        try {
            const result = await this.pool.query(sql, params);
            return result.rows;
        } catch (err) {
            log('error', `DB Error [${this.tableName}]`, { error: err.message, sql: sql.substring(0, 100) });
            throw err;
        }
    }

    /**
     * Obtener todos los registros activos de un restaurante
     */
    async findAll(restauranteId, options = {}) {
        const { orderBy = 'id', includeDeleted = false } = options;
        const deletedClause = includeDeleted ? '' : 'AND deleted_at IS NULL';

        return this.query(
            `SELECT * FROM ${this.tableName} WHERE restaurante_id = $1 ${deletedClause} ORDER BY ${orderBy}`,
            [restauranteId]
        );
    }

    /**
     * Buscar por ID
     */
    async findById(id, restauranteId) {
        const rows = await this.query(
            `SELECT * FROM ${this.tableName} WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL`,
            [id, restauranteId]
        );
        return rows[0] || null;
    }

    /**
     * Crear registro
     */
    async create(data, restauranteId) {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

        const result = await this.query(
            `INSERT INTO ${this.tableName} (${keys.join(', ')}, restaurante_id) 
             VALUES (${placeholders}, $${keys.length + 1}) RETURNING *`,
            [...values, restauranteId]
        );
        return result[0];
    }

    /**
     * Actualizar registro
     */
    async update(id, data, restauranteId) {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');

        const result = await this.query(
            `UPDATE ${this.tableName} SET ${setClause} WHERE id = $${keys.length + 1} AND restaurante_id = $${keys.length + 2} RETURNING *`,
            [...values, id, restauranteId]
        );
        return result[0] || null;
    }

    /**
     * Soft delete
     */
    async softDelete(id, restauranteId) {
        const result = await this.query(
            `UPDATE ${this.tableName} SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND restaurante_id = $2 RETURNING id`,
            [id, restauranteId]
        );
        return result.length > 0;
    }

    /**
     * Transacción
     */
    async withTransaction(callback) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}

module.exports = BaseService;
