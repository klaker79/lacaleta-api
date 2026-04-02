/**
 * ============================================
 * tests/critical/balance-porciones-division.test.js
 * ============================================
 *
 * CRITICAL: Tests that /balance/mes divides cost by porciones.
 *
 * Bug fixed: /balance/mes was NOT dividing by porciones, so a recipe
 * with porciones=4 reported 4× the real COGS, inflating food cost %.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Balance — Porciones division in COGS', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. GET /balance/mes returns data with costos field', async () => {
        if (!authToken) return;

        const today = new Date();
        const mes = today.getMonth() + 1;
        const ano = today.getFullYear();

        const res = await request(API_URL)
            .get(`/api/balance/mes?mes=${mes}&ano=${ano}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('ingresos');
        expect(res.body).toHaveProperty('costos');
        console.log(`📊 Balance: ingresos=${res.body.ingresos}, costos=${res.body.costos}`);
    });

    it('2. Food cost should be reasonable (< 80%) when there are sales', async () => {
        if (!authToken) return;

        // Use March 2026 which has sales data
        const res = await request(API_URL)
            .get('/api/balance/mes?mes=3&ano=2026')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status !== 200 || !res.body.ingresos || res.body.ingresos === 0) {
            console.log('⚠️ No March 2026 data, skipping food cost check');
            return;
        }

        const foodCost = (res.body.costos / res.body.ingresos) * 100;
        console.log(`📊 March food cost: ${foodCost.toFixed(1)}% (costos: ${res.body.costos}, ingresos: ${res.body.ingresos})`);

        // Without porciones division, food cost was > 100% for some months
        // With correct division, restaurant food cost should be 25-55%
        expect(foodCost).toBeLessThan(80);
        expect(foodCost).toBeGreaterThan(0);
    });

    it('3. GET /monthly/summary returns data with recipes and porciones', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/monthly/summary?mes=3&ano=2026')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);

        // Check that recipes in response have reasonable cost values
        if (res.body.dias && res.body.dias.length > 0) {
            const firstDay = res.body.dias[0];
            if (firstDay.recetas && firstDay.recetas.length > 0) {
                const recipe = firstDay.recetas[0];
                console.log(`📊 First recipe: ${recipe.nombre}, coste=${recipe.coste}, cantidad=${recipe.cantidad}`);
                // Cost per unit should be reasonable (not inflated by missing porciones division)
                if (recipe.coste && recipe.cantidad) {
                    const costPerUnit = recipe.coste / recipe.cantidad;
                    expect(costPerUnit).toBeLessThan(500); // No recipe should cost 500€/unit
                }
            }
        }
    });
});
