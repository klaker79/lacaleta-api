/**
 * Logger - Logging persistente a archivo (con rotación), consola y Sentry
 */

const fs = require('fs');
const path = require('path');
const Sentry = require('@sentry/node');

// Archivo de log en raíz del proyecto
const LOG_FILE = path.join(__dirname, '../../server.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

let writeCount = 0;

function rotateIfNeeded() {
    try {
        const stats = fs.statSync(LOG_FILE);
        if (stats.size > MAX_LOG_SIZE) {
            const rotated = LOG_FILE + '.1';
            if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
            fs.renameSync(LOG_FILE, rotated);
        }
    } catch (e) { /* file doesn't exist yet, ignore */ }
}

const log = (level, message, data = {}) => {
    const logEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...data
    });
    console.log(logEntry);

    // Rotar cada 100 escrituras si excede tamaño máximo
    if (++writeCount % 100 === 0) rotateIfNeeded();

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
