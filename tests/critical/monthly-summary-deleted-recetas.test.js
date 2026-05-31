/**
 * tests/critical/monthly-summary-deleted-recetas.test.js
 *
 * Blinda el endpoint GET /api/monthly/summary contra la regresión
 * "ventas con receta soft-eliminada desaparecen del Diario" (Capa 2 — 2026-05-31).
 *
 * Antes del fix: `JOIN recetas r ... AND r.deleted_at IS NULL` ocultaba
 * ingresos reales (cobrados, en caja) del mes. Diario marcaba menos €
 * que Dashboard.
 *
 * Tras el fix:
 *  - LEFT JOIN + r.deleted_at IS NULL movido al ON → la venta sigue
 *    apareciendo aunque la receta esté soft-eliminada.
 *  - Nombre fallback: `Receta eliminada #<id>`.
 *  - Coste fallback: snapshot histórico en ventas_diarias_resumen.
 *
 * Este test verifica el CONTRATO del endpoint (no se rompe, no devuelve
 * IDs null, todos los nombres son strings no vacíos). La verificación
 * NUMÉRICA del fix se hace post-deploy con SQL contra producción.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('GET /api/monthly/summary — contrato + fallback de recetas eliminadas', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. Responde 200 con estructura esperada', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/monthly/summary')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('mes');
        expect(res.body).toHaveProperty('ano');
        expect(res.body).toHaveProperty('dias');
        expect(res.body).toHaveProperty('compras');
        expect(res.body).toHaveProperty('ventas');
        expect(res.body).toHaveProperty('resumen');

        expect(res.body.compras).toHaveProperty('ingredientes');
        expect(res.body.compras).toHaveProperty('porProveedor');
        expect(res.body.compras).toHaveProperty('total');
        expect(res.body.ventas).toHaveProperty('recetas');
        expect(res.body.ventas).toHaveProperty('totalIngresos');
        expect(res.body.ventas).toHaveProperty('totalCostes');
        expect(res.body.ventas).toHaveProperty('beneficioBruto');
    });

    it('2. Todas las claves de ventas.recetas son strings no vacíos (incluido fallback "Receta eliminada #")', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/monthly/summary')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        const claves = Object.keys(res.body.ventas.recetas);

        claves.forEach(nombre => {
            // Sin esta protección, el LEFT JOIN podría devolver 'null' como string,
            // o claves vacías, y reventar la tabla del Diario.
            expect(typeof nombre).toBe('string');
            expect(nombre.length).toBeGreaterThan(0);
            expect(nombre).not.toBe('null');
            expect(nombre).not.toBe('undefined');
        });

        // Si hay alguna entrada con prefix de fallback, loggear para visibilidad.
        const fallbacks = claves.filter(n => /^Receta eliminada #\d+$/.test(n));
        if (fallbacks.length > 0) {
            console.log(`✅ ${fallbacks.length} receta(s) eliminada(s) con ventas visibles: ${fallbacks.slice(0, 3).join(', ')}${fallbacks.length > 3 ? '...' : ''}`);
        } else {
            console.log(`ℹ️ Sin recetas eliminadas con ventas este mes (tenant de test).`);
        }
    });

    it('3. Cada entrada de ventas.recetas tiene id numérico válido (no null por LEFT JOIN)', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/monthly/summary')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        Object.entries(res.body.ventas.recetas).forEach(([nombre, data]) => {
            // El SELECT usa v.receta_id (directo de ventas) en vez de r.id, así que
            // el id NUNCA debe ser null aunque la receta esté soft-eliminada.
            expect(data.id).toBeDefined();
            expect(data.id).not.toBeNull();
            expect(typeof data.id).toBe('number');
            expect(data.id).toBeGreaterThan(0);
            expect(typeof data.totalIngresos).toBe('number');
            expect(data.totalIngresos).toBeGreaterThanOrEqual(0);
        });
    });

    it('4. totalIngresos del mes >= suma de ingresos por receta (no se pierden ventas)', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/monthly/summary')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        const sumaRecetas = Object.values(res.body.ventas.recetas)
            .reduce((acc, r) => acc + (r.totalIngresos || 0), 0);

        // Tolerancia 0.5€ por redondeos de SUM en Postgres.
        expect(Math.abs(res.body.ventas.totalIngresos - sumaRecetas)).toBeLessThan(0.5);
        console.log(`✅ totalIngresos=${res.body.ventas.totalIngresos.toFixed(2)}€ ≈ Σ recetas=${sumaRecetas.toFixed(2)}€`);
    });

    it('5. Mes histórico (mes=1, ano=2026) sigue funcionando sin crash', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/monthly/summary?mes=1&ano=2026')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.mes).toBe(1);
        expect(res.body.ano).toBe(2026);
    });
});
