/**
 * Healthcheck script for Docker
 * Verifica que el servidor responda correctamente
 */

const http = require('http');

const options = {
    host: 'localhost',
    port: 3000,
    path: '/api/health',
    timeout: 8000,
    headers: { 'User-Agent': 'Docker-Healthcheck/1.0' }
};

const request = http.get(options, (res) => {
    // Cualquier respuesta 200 significa que el servidor está vivo
    if (res.statusCode === 200) {
        process.exit(0);
    }
    process.exit(1);
});

request.on('error', () => process.exit(1));
request.on('timeout', () => {
    request.destroy();
    process.exit(1);
});

request.end();
