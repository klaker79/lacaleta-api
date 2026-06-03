/**
 * Unit tests for onboardingService.
 *
 * Covers:
 *  - markStep ejecuta los 2 UPDATEs esperados (set + completado check).
 *  - markStep no rompe el flujo si el pool falla (no-bloqueante).
 *  - markStep ignora steps desconocidos sin lanzar.
 *  - markStep ignora restauranteId falsy sin lanzar.
 *  - getStatus mapea correctamente las 4 columnas a la respuesta.
 *
 * No usa DB real — mock del pool.
 */
const onboardingService = require('../../src/services/onboardingService');

function makePoolMock({ statusRow = null, throwOnUpdate = false } = {}) {
    const queries = [];
    return {
        queries,
        async query(sql, params) {
            queries.push({ sql, params });
            const t = sql.trim().toUpperCase();
            if (t.startsWith('UPDATE') && throwOnUpdate) {
                throw new Error('boom (db down)');
            }
            if (t.startsWith('SELECT')) {
                return { rows: statusRow ? [statusRow] : [] };
            }
            return { rowCount: 1 };
        }
    };
}

describe('onboardingService.markStep', () => {
    test('ejecuta los 2 UPDATEs (set + check completado) para un step válido', async () => {
        const pool = makePoolMock();
        await onboardingService.markStep(pool, 42, 'ingredientes');

        expect(pool.queries).toHaveLength(2);
        expect(pool.queries[0].sql).toMatch(/UPDATE restaurantes/);
        expect(pool.queries[0].sql).toMatch(/onboarding_ingredientes_at/);
        expect(pool.queries[0].params).toEqual([42]);

        // 2º UPDATE: setea onboarding_completado_at si los 4 están listos
        expect(pool.queries[1].sql).toMatch(/onboarding_completado_at/);
        expect(pool.queries[1].sql).toMatch(/onboarding_proveedores_at IS NOT NULL/);
        expect(pool.queries[1].sql).toMatch(/onboarding_pedidos_at IS NOT NULL/);
    });

    test('cada step usa su columna correspondiente', async () => {
        const cases = [
            ['proveedores', 'onboarding_proveedores_at'],
            ['ingredientes', 'onboarding_ingredientes_at'],
            ['recetas', 'onboarding_recetas_at'],
            ['pedidos', 'onboarding_pedidos_at']
        ];
        for (const [step, expectedCol] of cases) {
            const pool = makePoolMock();
            await onboardingService.markStep(pool, 1, step);
            expect(pool.queries[0].sql).toContain(expectedCol);
        }
    });

    test('no lanza si el pool falla — el flujo principal no debe romperse', async () => {
        const pool = makePoolMock({ throwOnUpdate: true });
        // Si esto lanza el test fallaría con uncaught
        await expect(onboardingService.markStep(pool, 1, 'recetas')).resolves.toBeUndefined();
    });

    test('ignora steps desconocidos sin tocar el pool', async () => {
        const pool = makePoolMock();
        await onboardingService.markStep(pool, 1, 'paso_inventado');
        expect(pool.queries).toHaveLength(0);
    });

    test('ignora restauranteId falsy sin tocar el pool', async () => {
        const pool = makePoolMock();
        await onboardingService.markStep(pool, null, 'recetas');
        await onboardingService.markStep(pool, undefined, 'recetas');
        await onboardingService.markStep(pool, 0, 'recetas');
        expect(pool.queries).toHaveLength(0);
    });
});

describe('onboardingService.getStatus', () => {
    test('mapea las 4 columnas a la lista de pasos en orden', async () => {
        const pool = makePoolMock({
            statusRow: {
                onboarding_proveedores_at: '2026-06-01T10:00:00Z',
                onboarding_ingredientes_at: '2026-06-02T10:00:00Z',
                onboarding_recetas_at: null,
                onboarding_pedidos_at: null,
                onboarding_completado_at: null
            }
        });

        const status = await onboardingService.getStatus(pool, 3);

        expect(status.pasos).toHaveLength(4);
        expect(status.pasos[0].key).toBe('proveedores');
        expect(status.pasos[0].completed_at).toBe('2026-06-01T10:00:00Z');
        expect(status.pasos[1].key).toBe('ingredientes');
        expect(status.pasos[1].completed_at).toBe('2026-06-02T10:00:00Z');
        expect(status.pasos[2].key).toBe('recetas');
        expect(status.pasos[2].completed_at).toBe(null);
        expect(status.pasos[3].key).toBe('pedidos');
        expect(status.pasos[3].completed_at).toBe(null);
        expect(status.completado).toBe(false);
    });

    test('completado=true cuando el tenant tiene onboarding_completado_at', async () => {
        const pool = makePoolMock({
            statusRow: {
                onboarding_proveedores_at: '2026-06-01T10:00:00Z',
                onboarding_ingredientes_at: '2026-06-02T10:00:00Z',
                onboarding_recetas_at: '2026-06-03T10:00:00Z',
                onboarding_pedidos_at: '2026-06-04T10:00:00Z',
                onboarding_completado_at: '2026-06-04T10:00:01Z'
            }
        });

        const status = await onboardingService.getStatus(pool, 3);
        expect(status.completado).toBe(true);
        expect(status.completado_at).toBe('2026-06-04T10:00:01Z');
    });

    test('tenant inexistente devuelve estructura vacía sin lanzar', async () => {
        const pool = makePoolMock({ statusRow: null });
        const status = await onboardingService.getStatus(pool, 999999);
        expect(status.pasos).toHaveLength(4);
        expect(status.pasos.every(p => p.completed_at === null)).toBe(true);
        expect(status.completado).toBe(false);
    });
});
