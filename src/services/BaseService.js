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

/**
 * 🔒 Auditoría 2026-07-28: esta clase interpola identificadores (tabla, columnas,
 * ORDER BY) directamente en el SQL, porque los identificadores NO admiten
 * placeholders $N. Hoy no es explotable — `orderBy` nunca se alimenta de
 * req.query y `tableName` es una constante del código —, pero bastaría con que
 * alguien pasara un valor de usuario para abrir una inyección. Este guard cierra
 * esa puerta en el sitio, no en cada llamada.
 *
 * Acepta solo identificadores SQL simples, con sufijo opcional ASC/DESC:
 *   'id', 'nombre DESC', 'created_at asc'
 */
const SQL_IDENT = /^[a-z_][a-z0-9_]*$/i;

function assertIdent(value, what) {
    if (typeof value !== 'string' || !SQL_IDENT.test(value)) {
        throw new Error(`BaseService: ${what} inválido: ${JSON.stringify(value)}`);
    }
    return value;
}

function assertOrderBy(value) {
    const parts = String(value).trim().split(/\s+/);
    if (parts.length > 2) throw new Error(`BaseService: orderBy inválido: ${JSON.stringify(value)}`);
    assertIdent(parts[0], 'columna de orderBy');
    if (parts[1] && !/^(asc|desc)$/i.test(parts[1])) {
        throw new Error(`BaseService: dirección de orden inválida: ${JSON.stringify(parts[1])}`);
    }
    return parts.join(' ');
}

class BaseService {
    constructor(tableName) {
        this.tableName = assertIdent(tableName, 'nombre de tabla');
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
        const safeOrderBy = assertOrderBy(orderBy);

        return this.query(
            `SELECT * FROM ${this.tableName} WHERE restaurante_id = $1 ${deletedClause} ORDER BY ${safeOrderBy}`,
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
        const keys = Object.keys(data).map(k => assertIdent(k, 'nombre de columna'));
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
        const keys = Object.keys(data).map(k => assertIdent(k, 'nombre de columna'));
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
