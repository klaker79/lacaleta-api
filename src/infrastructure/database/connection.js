/**
 * Database connection pool
 * Centraliza la conexión a PostgreSQL
 */

const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'lacaleta',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    max: parseInt(process.env.DB_POOL_MAX_SECONDARY) || 20,
    idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_MS) || 10000,
    connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECT_MS) || 10000
});

// Log de conexión
pool.on('connect', () => {
    console.log('[DB] New client connected');
});

pool.on('error', (err) => {
    console.error('[DB] Unexpected error:', err);
});

/**
 * Ejecuta una transacción
 * @param {Function} callback - Función que recibe el client
 */
async function withTransaction(callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = pool;
module.exports.withTransaction = withTransaction;
