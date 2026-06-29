/**
 * Rate Limiting Middleware
 * Protección contra DDoS y brute-force
 */

const rateLimit = require('express-rate-limit');

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 2000, // 2000 requests por ventana (margen de seguridad)
    message: { error: 'Demasiadas peticiones, intenta más tarde' },
    standardHeaders: true,
    legacyHeaders: false
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: parseInt(process.env.AUTH_RATE_LIMIT, 10) || 20, // 20 en prod, configurable para CI
    message: { error: 'Demasiados intentos de login, espera 15 minutos' },
    standardHeaders: true,
    legacyHeaders: false
});

// Limiter para endpoints costosos (APIs de pago como Anthropic)
const costlyApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: parseInt(process.env.COSTLY_RATE_LIMIT, 10) || 30, // 30 en prod, configurable para CI (la suite --runInBand desde 1 IP agotaba la cubeta compartida → 429 flaky)
    message: { error: 'Demasiadas solicitudes de procesamiento IA, intenta más tarde' },
    standardHeaders: true,
    legacyHeaders: false
});

module.exports = { globalLimiter, authLimiter, costlyApiLimiter };
