// Sentry instrumentation - MUST be loaded before everything else
const Sentry = require("@sentry/node");

Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    release: '2.3.1',
    sendDefaultPii: false, // RGPD: no enviar datos personales (cookies, tokens, IPs)
});
