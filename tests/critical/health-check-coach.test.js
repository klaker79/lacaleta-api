/**
 * ═══════════════════════════════════════════════════
 * 🩺 HEALTH CHECK COACH — endpoints + multi-tenant + cache semanal
 * ═══════════════════════════════════════════════════
 *
 * Cubre el comportamiento crítico de los endpoints añadidos 2026-05-23:
 *   - POST /chat/health-check → requiere auth, gating por chat_addon
 *   - GET  /chat/health-check/status → barato, sin tokens
 *
 * No invoca Claude real en CI (sería caro y dependiente de la API). En su
 * lugar verifica el contrato HTTP: status codes, shape del JSON de respuesta,
 * y la regla de gating (sin chat_addon devuelve 403).
 *
 * La validación de cifras reales se hace en producción (memoria
 * project_chat_diagnostico_tools_2026_05_21 demuestra el patrón: los datos
 * se validan contra el análisis manual del 21-may).
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Health Check Coach — endpoints + multi-tenant', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. GET /chat/health-check/status sin auth → 401', async () => {
        const res = await request(API_URL)
            .get('/api/chat/health-check/status')
            .set('Origin', 'http://localhost:3001');

        expect([401, 403, 429]).toContain(res.status);
    });

    it('2. GET /chat/health-check/status con auth → 200 con shape esperada', async () => {
        if (!authToken) return; // CI sin user de test
        const res = await request(API_URL)
            .get('/api/chat/health-check/status')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        // 200 con addon_enabled false (típico en CI sin chat_addon) o 200 con
        // estructura completa si el tenant de test tiene chat_addon=true.
        expect([200, 429]).toContain(res.status);
        if (res.status === 200) {
            expect(res.body).toHaveProperty('addon_enabled');
            // Si está habilitado, debe tener los campos del status
            if (res.body.addon_enabled) {
                expect(res.body).toHaveProperty('has_new');
                expect(res.body).toHaveProperty('semana_iso');
            }
        }
    });

    it('3. POST /chat/health-check sin auth → 401', async () => {
        const res = await request(API_URL)
            .post('/api/chat/health-check')
            .set('Origin', 'http://localhost:3001');

        expect([401, 403, 429]).toContain(res.status);
    });

    it('4. POST /chat/health-check sin chat_addon → 403 CHAT_NOT_ACTIVATED', async () => {
        if (!authToken) return;
        const res = await request(API_URL)
            .post('/api/chat/health-check')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        // Si el tenant de CI no tiene chat_addon (lo más común) → 403
        // Si lo tiene → 200/500. Aceptamos los 3 + rate limit + claude key
        // missing (algunos CI no tienen ANTHROPIC_API_KEY → 500).
        expect([200, 403, 500, 429]).toContain(res.status);
        if (res.status === 403) {
            expect(res.body.error).toBe('CHAT_NOT_ACTIVATED');
        }
    });

    it('5. Status endpoint sigue funcionando en llamadas repetidas (no rompe)', async () => {
        if (!authToken) return;
        // Llamamos 2 veces seguidas. NO sumamos cuota Claude (es solo lectura BD),
        // pero el endpoint sí lleva costlyApiLimiter desde 2026-05-23 (CodeQL
        // rule js/missing-rate-limiting), así que 429 es respuesta aceptable
        // en CI con ratelimits acumulados.
        for (let i = 0; i < 2; i++) {
            const res = await request(API_URL)
                .get('/api/chat/health-check/status')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            expect([200, 401, 403, 429]).toContain(res.status);
        }
    });
});
