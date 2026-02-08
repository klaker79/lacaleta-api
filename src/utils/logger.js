/**
 * Logger - Logging persistente a archivo, consola y Sentry
 */

const fs = require('fs');
const path = require('path');
const Sentry = require('@sentry/node');

// Archivo de log en raíz del proyecto
const LOG_FILE = path.join(__dirname, '../../server.log');

const log = (level, message, data = {}) => {
    const logEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...data
    });
    console.log(logEntry);
    fs.appendFile(LOG_FILE, logEntry + '\n', (err) => {
        if (err) console.error('Error writing to log file:', err);
    });

    // Capturar errores en Sentry automáticamente
    if (level === 'error' && process.env.SENTRY_DSN) {
        const errorMsg = data.error ? `${message}: ${data.error}` : message;
        Sentry.captureMessage(errorMsg, {
            level: 'error',
            extra: data
        });
    }
};

module.exports = { log };
