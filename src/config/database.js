/**
 * ============================================
 * config/database.js - Pool de Base de Datos
 * ============================================
 *
 * Configuración centralizada de PostgreSQL pool.
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const { Pool } = require('pg');
const config = require('./index');
const { log } = require('../utils/logger');

// Crear pool con configuración centralizada
const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    max: config.database.max,
    idleTimeoutMillis: config.database.idleTimeoutMillis,
    connectionTimeoutMillis: config.database.connectionTimeoutMillis,
    keepAlive: config.database.keepAlive,
    keepAliveInitialDelayMillis: config.database.keepAliveInitialDelayMillis
});

// Manejar errores del pool (evita crash)
pool.on('error', (err) => {
    log('error', 'Error inesperado en pool de BD', { error: err.message });
});

// Test de conexión
const testConnection = async () => {
    try {
        await pool.query('SELECT NOW()');
        log('info', 'Conectado a PostgreSQL');
        return true;
    } catch (err) {
        log('error', 'Error conectando a PostgreSQL', { error: err.message });
        return false;
    }
};

module.exports = { pool, testConnection };
