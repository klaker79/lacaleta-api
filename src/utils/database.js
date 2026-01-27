/**
 * ============================================
 * database.js - Configuración de Base de Datos
 * ============================================
 * 
 * Pool de conexiones PostgreSQL centralizado.
 * 
 * @author MindLoopIA
 * @version 1.0.0
 */

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000
});

// Manejar errores del pool
pool.on('error', (err) => {
    console.error('❌ Error inesperado en pool de BD:', err.message);
});

module.exports = { pool };
