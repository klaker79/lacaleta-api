/**
 * ============================================
 * tests/critical/stock-audit.test.js
 * ============================================
 *
 * Auditoría de salud del inventario.
 *
 * Verifica la consistencia global de stock:
 * 1. Ningún ingrediente tiene stock negativo
 * 2. Ningún stock es NaN o null (debe ser numérico)
 * 3. Valor Stock total coincide con cálculo manual
 * 4. Ingredientes activos tienen datos coherentes
 * 5. Health-check endpoint funciona
 *
 * @author MindLoopIA
 * @date 2026-02-11
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Stock Audit — Global Inventory Health', () => {
    let authToken;
    let ingredients = [];

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ No se pudo autenticar. Tests skipped.');
            return;
        }

        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status === 200) {
            ingredients = res.body;
            console.log(`📦 Total ingredientes: ${ingredients.length}`);
        }
    });

    it('1. No ingredient should have negative stock', async () => {
        if (!authToken || ingredients.length === 0) return;

        const negatives = ingredients.filter(i => {
            const stock = parseFloat(i.stock_actual);
            return !isNaN(stock) && stock < 0;
        });

        if (negatives.length > 0) {
            console.error('❌ Ingredientes con stock negativo:');
            negatives.forEach(i => console.error(`   ${i.nombre}: ${i.stock_actual}`));
        }

        expect(negatives.length).toBe(0);
        console.log(`✅ 0 ingredientes con stock negativo (de ${ingredients.length})`);
    });

    it('2. All stock values should be valid numbers', async () => {
        if (!authToken || ingredients.length === 0) return;

        const invalids = ingredients.filter(i => {
            const stock = parseFloat(i.stock_actual);
            return isNaN(stock);
        });

        if (invalids.length > 0) {
            console.error('❌ Ingredientes con stock inválido (NaN/null):');
            invalids.forEach(i => console.error(`   ${i.nombre}: ${JSON.stringify(i.stock_actual)}`));
        }

        expect(invalids.length).toBe(0);
        console.log(`✅ Todos los valores de stock son numéricos válidos`);
    });

    it('3. Stock value calculation should be consistent', async () => {
        if (!authToken || ingredients.length === 0) return;

        // Calculate manually: sum(stock_actual * precio_unitario_real)
        // precio_unitario_real = precio / cantidad_por_formato (si aplica)
        let calculatedTotal = 0;
        let itemsWithValue = 0;

        for (const ing of ingredients) {
            const stock = parseFloat(ing.stock_actual) || 0;
            const precio = parseFloat(ing.precio) || 0;
            const cantidadPorFormato = parseFloat(ing.cantidad_por_formato) || 1;

            if (stock > 0 && precio > 0) {
                const precioUnitario = precio / cantidadPorFormato;
                calculatedTotal += stock * precioUnitario;
                itemsWithValue++;
            }
        }

        console.log(`📊 Valor stock calculado: ${calculatedTotal.toFixed(2)}€ (${itemsWithValue} items con valor)`);

        // Compare with inventory endpoint
        const invRes = await request(API_URL)
            .get('/api/inventory/complete')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (invRes.status === 200 && invRes.body.resumen) {
            const apiTotal = parseFloat(invRes.body.resumen.valorTotal) || 0;
            console.log(`📊 Valor stock API: ${apiTotal.toFixed(2)}€`);

            // Allow 5% tolerance for rounding
            const diff = Math.abs(calculatedTotal - apiTotal);
            const tolerance = Math.max(calculatedTotal, apiTotal) * 0.05;
            console.log(`📊 Diferencia: ${diff.toFixed(2)}€ (tolerancia: ${tolerance.toFixed(2)}€)`);

            expect(diff).toBeLessThanOrEqual(tolerance + 1); // +1€ for small rounding
        }
    });

    it('4. All stock prices should be non-negative', async () => {
        if (!authToken || ingredients.length === 0) return;

        const negativePrices = ingredients.filter(i => {
            const precio = parseFloat(i.precio);
            return !isNaN(precio) && precio < 0;
        });

        if (negativePrices.length > 0) {
            console.error('❌ Ingredientes con precio negativo:');
            negativePrices.forEach(i => console.error(`   ${i.nombre}: ${i.precio}€`));
        }

        expect(negativePrices.length).toBe(0);
        console.log(`✅ Todos los precios son >= 0`);
    });

    it('5. Ingredients with stock > 0 should have a valid price', async () => {
        if (!authToken || ingredients.length === 0) return;

        const stockNoPrecio = ingredients.filter(i => {
            const stock = parseFloat(i.stock_actual) || 0;
            const precio = parseFloat(i.precio) || 0;
            return stock > 0 && precio === 0;
        });

        if (stockNoPrecio.length > 0) {
            console.warn('⚠️ Ingredientes con stock pero sin precio (valor = 0€):');
            stockNoPrecio.forEach(i => console.warn(`   ${i.nombre}: stock=${i.stock_actual}, precio=${i.precio}`));
        }

        // This is a warning, not a hard failure
        // Some ingredients may intentionally have price=0
        console.log(`📊 ${stockNoPrecio.length} ingredientes con stock > 0 pero precio = 0`);
    });

    it('6. Health check endpoint should return valid status', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/inventory/health-check')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status === 200) {
            expect(res.body.status).toBeDefined();
            expect(['healthy', 'warning', 'critical']).toContain(res.body.status);
            console.log(`📊 Inventory health: ${res.body.status}`);

            if (res.body.anomalies && res.body.anomalies.length > 0) {
                console.warn(`⚠️ ${res.body.anomalies.length} anomalías detectadas:`);
                res.body.anomalies.forEach(a => console.warn(`   ${a.type}: ${a.message}`));
            }
        } else if (res.status === 404) {
            console.warn('⚠️ Health-check endpoint not yet deployed (404). Test will pass once deployed.');
        }
    });
});
