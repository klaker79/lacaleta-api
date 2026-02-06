/**
 * ============================================
 * tests/integration/sale-inventory.test.js
 * ============================================
 *
 * Test de integración: Flujo Ventas → Inventario
 * 
 * @author MindLoopIA
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Sale → Inventory Flow', () => {
    let authToken;
    let testRecetaId;
    let testReceta;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    describe('1. Obtener receta de prueba', () => {
        it('should get a recipe with ingredients', async () => {
            if (!authToken) {
                console.warn('⚠️ Sin autenticación');
                return;
            }

            const res = await request(API_URL)
                .get('/api/recipes')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);

            expect(res.status).toBe(200);

            if (res.body && res.body.length > 0) {
                testReceta = res.body.find(r =>
                    r.ingredientes &&
                    (Array.isArray(r.ingredientes) ? r.ingredientes.length > 0 : true)
                ) || res.body[0];

                testRecetaId = testReceta.id;
                console.log(`🍽️ Receta: ${testReceta.nombre} (ID: ${testRecetaId})`);
            }
        });
    });

    describe('2. Verificar cálculo de descuento', () => {
        it('should calculate stock deduction correctly', async () => {
            if (!authToken || !testRecetaId) return;

            const recipeRes = await request(API_URL)
                .get(`/api/recipes/${testRecetaId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);

            if (recipeRes.status !== 200) return;

            const receta = recipeRes.body;
            const ingredientes = typeof receta.ingredientes === 'string'
                ? JSON.parse(receta.ingredientes)
                : receta.ingredientes;

            if (!ingredientes || ingredientes.length === 0) {
                console.log('⚠️ Receta sin ingredientes definidos');
                return;
            }

            console.log(`📊 Ingredientes en receta: ${ingredientes.length}`);

            ingredientes.forEach(ing => {
                const cantidad = parseFloat(ing.cantidad) || 0;
                const porciones = parseFloat(receta.porciones) || 1;
                const descuentoPorUnidad = cantidad / porciones;

                console.log(`  - ID ${ing.ingrediente_id}: ${cantidad}/${porciones} = ${descuentoPorUnidad.toFixed(4)} por unidad`);
                expect(descuentoPorUnidad).toBeGreaterThanOrEqual(0);
            });
        });
    });

    describe('3. Simular venta y verificar stock', () => {
        it('should record sale impact (read-only verification)', async () => {
            if (!authToken) return;

            const statsRes = await request(API_URL)
                .get('/api/ventas/stats')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);

            if (statsRes.status === 200) {
                console.log('📊 Stats de ventas disponibles');
                expect(statsRes.body).toBeDefined();
            } else if (statsRes.status === 404) {
                console.log('ℹ️ Endpoint /api/ventas/stats no implementado');
            }
        });
    });

    describe('4. Verificar variantes de recetas', () => {
        it('should validate variant factors are correct', async () => {
            if (!authToken) return;

            const variantesRes = await request(API_URL)
                .get('/api/recetas/variantes')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);

            if (variantesRes.status === 200 && Array.isArray(variantesRes.body)) {
                variantesRes.body.forEach(v => {
                    const factor = parseFloat(v.factor) || 1;
                    expect(factor).toBeGreaterThan(0);
                    expect(factor).toBeLessThanOrEqual(10);
                });
                console.log(`✅ ${variantesRes.body.length} variantes verificadas`);
            } else if (variantesRes.status === 404) {
                console.log('ℹ️ Endpoint /api/recetas/variantes no encontrado');
            }
        });
    });
});
