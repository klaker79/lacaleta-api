// tests/setup.js - Setup para tests de integración
require('dotenv').config();

// Log de variables de test (sin mostrar passwords)
console.log('📋 Test config loaded:', {
    TEST_USER_EMAIL: process.env.TEST_USER_EMAIL || 'NOT SET',
    API_URL: process.env.API_URL || 'http://localhost:3001'
});

// Helper para crear request con headers necesarios
const supertest = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

// Wrapper que añade Origin header automáticamente
const originalRequest = supertest(API_URL);

global.apiRequest = (method, path) => {
    return originalRequest[method](path)
        .set('Origin', 'http://localhost:3001');
};

// Cache del token para reutilizar
global.cachedAuthToken = null;

global.getAuthToken = async () => {
    if (global.cachedAuthToken) return global.cachedAuthToken;

    const res = await supertest(API_URL)
        .post('/api/auth/login')
        .set('Origin', 'http://localhost:3001')
        .set('Content-Type', 'application/json')
        .send({
            email: process.env.TEST_USER_EMAIL || 'test@test.com',
            password: process.env.TEST_USER_PASSWORD || 'test123'
        });

    if (res.body.token) {
        global.cachedAuthToken = res.body.token;
        return res.body.token;
    }
    return null;
};

global.authenticatedRequest = async (method, path) => {
    const token = await global.getAuthToken();
    return supertest(API_URL)[method](path)
        .set('Origin', 'http://localhost:3001')
        .set('Authorization', `Bearer ${token}`);
};
