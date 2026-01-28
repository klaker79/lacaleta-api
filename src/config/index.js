/**
 * ============================================
 * config/index.js - Configuración Centralizada
 * ============================================
 *
 * Toda la configuración de la aplicación en un solo lugar.
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

require('dotenv').config();

// Validación de variables críticas
if (!process.env.JWT_SECRET) {
    console.error('❌ FATAL ERROR: JWT_SECRET no configurado');
    process.exit(1);
}

const config = {
    // JWT
    jwt: {
        secret: process.env.JWT_SECRET,
        expiresIn: '7d'
    },

    // Base de datos
    database: {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 5432,
        name: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000
    },

    // Server
    server: {
        port: process.env.PORT || 3000,
        env: process.env.NODE_ENV || 'development',
        isProduction: process.env.NODE_ENV === 'production'
    },

    // CORS
    cors: {
        defaultOrigins: [
            'https://klaker79.github.io',
            'https://app.mindloop.cloud',
            'http://localhost:5500',
            'http://127.0.0.1:5500',
            'http://localhost:3000',
            'http://localhost:3001',
            'http://localhost:3002',
            'http://localhost:8080'
        ],
        envOrigins: process.env.ALLOWED_ORIGINS?.split(',') || []
    },

    // Rate limiting
    rateLimit: {
        global: {
            windowMs: 15 * 60 * 1000,
            max: 1000
        },
        auth: {
            windowMs: 15 * 60 * 1000,
            max: 50
        }
    },

    // Email (Resend)
    email: {
        apiKey: process.env.RESEND_API_KEY
    },

    // Invitation code
    invitationCode: process.env.INVITATION_CODE
};

// Combinar orígenes CORS
config.cors.allowedOrigins = [
    ...new Set([...config.cors.defaultOrigins, ...config.cors.envOrigins])
];

module.exports = config;
