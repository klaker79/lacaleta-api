/**
 * ═══════════════════════════════════════════════════
 * 🩺 HEALTH CHECK COACH — endpoints + multi-tenant
 * ═══════════════════════════════════════════════════
 *
 * Cubre el contrato HTTP de los endpoints añadidos 2026-05-23:
 *   - POST /chat/health-check → requiere auth + suscripción activa (gate global).
 *     Single-plan (2026-06-09): el Coach va INCLUIDO en el plan; ya NO se chequea
 *     chat_addon, así que este endpoint nunca debe devolver CHAT_NOT_ACTIVATED.
 *   - GET  /chat/health-check/status → barato, sin tokens
 *
 * No invoca Claude real en CI (caro y dependiente de la API). Solo verifica
 * que los endpoints existen, responden con un status conocido, y que la
 * estructura del body es coherente cuando hay éxito.
 *
 * La validación de cifras reales se hace en producción (memoria
 * project_chat_diagnostico_tools_2026_05_21 demuestra el patrón).
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

// Status considerados "no-éxito esperado" en CI: el endpoint existe pero
// devuelve algo no-200. Cubre las respuestas controladas (4xx) y el caso
// de 500 cuando ANTHROPIC_API_KEY no está + 429 con ratelimit acumulado.
const NON_SUCCESS_OR_429 = [400, 401, 403, 429, 500];

describe('Health Check Coach — endpoints + multi-tenant', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. GET /chat/health-check/status sin auth → rechaza', async () => {
        const res = await request(API_URL)
            .get('/api/chat/health-check/status')
            .set('Origin', 'http://localhost:3001');

        // Sin token: 401 normalmente; 429 si ratelimit interfiere.
        expect(NON_SUCCESS_OR_429).toContain(res.status);
    });

    it('2. GET /chat/health-check/status con auth → 200 o 429', async () => {
        if (!authToken) return; // CI sin user de test
        const res = await request(API_URL)
            .get('/api/chat/health-check/status')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        // Aceptamos 200 (lo esperado), 429 (ratelimit) o 500 (config faltante).
        expect([200, 429, 500]).toContain(res.status);
        if (res.status === 200) {
            expect(res.body).toHaveProperty('addon_enabled');
        }
    });

    it('3. POST /chat/health-check sin auth → rechaza', async () => {
        const res = await request(API_URL)
            .post('/api/chat/health-check')
            .set('Origin', 'http://localhost:3001');

        expect(NON_SUCCESS_OR_429).toContain(res.status);
    });

    it('4. POST /chat/health-check con auth → respuesta controlada', async () => {
        if (!authToken) return;
        const res = await request(API_URL)
            .post('/api/chat/health-check')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        // Posibles status según config de CI (single-plan 2026-06-09):
        //   200 — plan activo + Claude key + datos suficientes (raro en CI)
        //   403 — SUBSCRIPTION_REQUIRED si el tenant de test no tiene plan vigente
        //         (lo emite el gate global de server.js, NO este endpoint)
        //   500 — ANTHROPIC_API_KEY missing o JSON inválido del modelo
        //   429 — ratelimit acumulado
        expect([200, 403, 429, 500]).toContain(res.status);
        if (res.status === 403) {
            // Regresión: el gate de chat_addon se eliminó. El único 403 legítimo
            // ahora es el del gate global de suscripción.
            expect(res.body.error).not.toBe('CHAT_NOT_ACTIVATED');
            expect(res.body.error).toBe('SUBSCRIPTION_REQUIRED');
        }
    });
});
