/**
 * ============================================
 * logger.js - Sistema de Logging
 * ============================================
 * 
 * Logging estructurado con persistencia a archivo.
 * 
 * @author MindLoopIA
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../../server.log');

/**
 * Log estructurado a consola y archivo
 * @param {string} level - 'info', 'warn', 'error'
 * @param {string} message - Mensaje
 * @param {object} data - Datos adicionales
 */
function log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = JSON.stringify({ timestamp, level, message, ...data });

    // Consola
    const logFn = level === 'error' ? console.error :
        level === 'warn' ? console.warn : console.log;
    logFn(`[${level.toUpperCase()}] ${message}`, data);

    // Archivo
    fs.appendFileSync(LOG_FILE, logEntry + '\n');
}

module.exports = { log };
