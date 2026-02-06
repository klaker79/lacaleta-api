/**
 * Logger - Logging persistente a archivo y consola
 */

const fs = require('fs');
const path = require('path');

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
};

module.exports = { log };
