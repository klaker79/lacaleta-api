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
        max: parseInt(process.env.DB_POOL_MAX) || 40,
        idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_MS) || 10000,
        connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECT_MS) || 10000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000
    },

    // Server
    server: {
        port: process.env.PORT || 3000,
        env: process.env.NODE_ENV || 'development',
        isProduction: process.env.NODE_ENV === 'production'
    },

    // CORS — UNA sola lista, y en producción sale SOLO de ALLOWED_ORIGINS.
    //
    // Antes los dominios de producción estaban cableados aquí y además en
    // `server.js`, cada uno con su copia. Eso es lo que permitió, arreglando la
    // casa Lite, tocar la copia de este archivo, ver el test en verde, y que la
    // API siguiera usando la OTRA lista. Se descubrió solo porque se comprobó
    // contra la API viva.
    //
    // Con los dominios fuera del código, cada casa (producción / staging /
    // Lite) acepta únicamente el frontend que le corresponde, y cambiar eso es
    // cambiar una variable, no desplegar código. Los localhost se quedan para
    // desarrollo, donde sí hacen falta y no hay nada que aislar.
    cors: {
        defaultOrigins: process.env.NODE_ENV === 'production'
            ? []
            : [
                'http://localhost:3000',    // Vite dev (demo)
                'http://localhost:3001',
                'http://localhost:3002',
                'http://localhost:5173',    // Vite dev
                'http://localhost:5174',    // Admin panel dev
                'http://localhost:5500',    // Live Server
                'http://127.0.0.1:5500',
                'http://localhost:8080'
            ],
        // `.trim()` porque la variable se escribe a mano en Dokploy y un espacio
        // detrás de la coma dejaba el origen fuera sin avisar.
        envOrigins: process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean) || []
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

// En producción los orígenes salen solo de ALLOWED_ORIGINS. Si falta, la lista
// queda vacía y el navegador bloquea TODAS las llamadas del frontend: la app
// parece caída y el motivo no se ve por ningún lado. Mejor no arrancar y
// decirlo claro que arrancar rota.
if (config.server.isProduction && config.cors.allowedOrigins.length === 0) {
    console.error(
        '❌ FATAL ERROR: ALLOWED_ORIGINS no configurado.\n'
        + '   En producción los orígenes CORS salen solo de esta variable.\n'
        // Sin dominios reales en el ejemplo: el sentido de este cambio es que
        // los dominios de cada casa vivan en la variable, no en el código.
        + '   Formato: ALLOWED_ORIGINS=https://tu-frontend,https://tu-panel-admin'
    );
    process.exit(1);
}

module.exports = config;
