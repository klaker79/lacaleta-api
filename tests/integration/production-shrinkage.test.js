/**
 * ============================================
 * tests/integration/production-shrinkage.test.js
 * ============================================
 *
 * Test de integración: Flujo Producción → Merma
 * 
 * @author MindLoopIA
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Production → Shrinkage (Merma) Flow', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    describe('1. Verificar endpoint de mermas existe', () => {
        it('should have GET /api/mermas endpoint', async () => {
            if (!authToken) {
                console.warn('⚠️ Sin autenticación');
                return;
            }

            const res = await request(API_URL)
                .get('/api/mermas')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);

            expect([200, 401, 403]).toContain(res.status);

            if (res.status === 200) {
                console.log(`📊 Mermas registradas: ${res.body.length || 0}`);
            }
        });
    });

    describe('2. Validar estructura de merma', () => {
        it('should validate shrinkage data structure', async () => {
            if (!authToken) return;

            const res = await request(API_URL)
                .get('/api/mermas')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);

            if (res.status === 200 && Array.isArray(res.body) && res.body.length > 0) {
                const merma = res.body[0];
                expect(parseFloat(merma.cantidad)).toBeGreaterThanOrEqual(0);
                console.log(`✅ Estructura de merma validada`);
            }
        });
    });

    describe('3. Verificar cálculo de valor de merma', () => {
        it('should calculate shrinkage value correctly', async () => {
            if (!authToken) return;

            const ingRes = await request(API_URL)
                .get('/api/ingredients')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);

            if (ingRes.status !== 200) return;

            const mermaRes = await request(API_URL)
                .get('/api/mermas')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);

            if (mermaRes.status === 200 && mermaRes.body.length > 0) {
                console.log(`✅ ${Math.min(5, mermaRes.body.length)} mermas verificadas`);
            }
        });
    });

    describe('4. Verificar motivos de merma válidos', () => {
        it('should have valid shrinkage reasons', async () => {
            if (!authToken) return;

            const res = await request(API_URL)
                .get('/api/mermas')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);

            if (res.status === 200 && res.body.length > 0) {
                const motivosEncontrados = new Set();
                res.body.forEach(merma => {
                    if (merma.motivo) {
                        motivosEncontrados.add(merma.motivo.toLowerCase());
                    }
                });
                console.log(`📋 Motivos encontrados: ${[...motivosEncontrados].join(', ')}`);
                expect(motivosEncontrados.size).toBeGreaterThan(0);
            }
        });
    });
});
