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
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        if (res.statusCode === 200) {
            try {
                const json = JSON.parse(data);
                if (json.status === 'healthy') {  // API devuelve 'healthy'
                    process.exit(0);
                }
            } catch (e) {
                // JSON parse failed
            }
        }
        process.exit(1);
    });
});

request.on('error', () => process.exit(1));
request.on('timeout', () => {
    request.destroy();
    process.exit(1);
});

request.end();
