/**
 * Unit tests para chatAddonGate middleware.
 *
 * Cubre los 4 caminos:
 *   1. addon=false → 403 CHAT_NOT_ACTIVATED, no incrementa contador
 *   2. addon=true, cuota disponible → next() + incrementa
 *   3. cuota agotada → 429 CHAT_QUOTA_EXCEEDED + resets_at en respuesta
 *   4. reset_at caducado → resetea a 0 antes de evaluar cuota
 *
 * Fast-path: mock del pool/client de pg, sin DB real.
 */

const { chatAddonGate, CHAT_MONTHLY_LIMIT } = require('../../src/middleware/chatAddonGate');

function makePoolMock(scenario) {
    const queries = [];
    const client = {
        async query(sql, params) {
            queries.push({ sql, params });
            const trimmed = sql.trim().toUpperCase();
            if (trimmed.startsWith('BEGIN')) return { rows: [] };
            if (trimmed.startsWith('COMMIT')) return { rows: [] };
            if (trimmed.startsWith('ROLLBACK')) return { rows: [] };
            // SELECT FOR UPDATE
            if (trimmed.startsWith('SELECT')) return { rows: [scenario.row] };
            // UPDATE chat_consultas_mes = 0 (reset perezoso)
            if (sql.includes('chat_consultas_mes = 0')) return { rowCount: 1 };
            // UPDATE +1 RETURNING
            if (trimmed.startsWith('UPDATE')) {
                return {
                    rows: [{ chat_consultas_mes: scenario.row.chat_consultas_mes + 1 }]
                };
            }
            return { rows: [] };
        },
        release() { /* noop */ }
    };
    return {
        client,
        queries,
        async connect() { return client; }
    };
}

function mockReqRes(restauranteId = 3) {
    const req = { restauranteId };
    let statusCode = 200;
    let payload = null;
    let nextCalled = false;
    const res = {
        status(code) { statusCode = code; return this; },
        json(body) { payload = body; return this; },
        get statusCode() { return statusCode; },
        get payload() { return payload; }
    };
    const next = () => { nextCalled = true; };
    return { req, res, next, getNextCalled: () => nextCalled, getStatus: () => statusCode, getPayload: () => payload };
}

describe('chatAddonGate', () => {
    test('addon=false → 403 CHAT_NOT_ACTIVATED, no llama next', async () => {
        const pool = makePoolMock({
            row: {
                chat_addon: false,
                chat_consultas_mes: 0,
                chat_consultas_reset_at: new Date(),
                next_reset: new Date(Date.now() + 30 * 86400000)
            }
        });
        const { req, res, next, getNextCalled, getStatus, getPayload } = mockReqRes();
        await chatAddonGate(pool)(req, res, next);
        expect(getStatus()).toBe(403);
        expect(getPayload()).toMatchObject({ error: 'CHAT_NOT_ACTIVATED' });
        expect(getNextCalled()).toBe(false);
        // Debe rollback (no hubo commit)
        expect(pool.queries.some(q => /ROLLBACK/i.test(q.sql))).toBe(true);
    });

    test('addon=true con cuota disponible → next() y contador +1', async () => {
        const pool = makePoolMock({
            row: {
                chat_addon: true,
                chat_consultas_mes: 50,
                chat_consultas_reset_at: new Date(),
                next_reset: new Date(Date.now() + 30 * 86400000)
            }
        });
        const { req, res, next, getNextCalled, getStatus } = mockReqRes();
        await chatAddonGate(pool)(req, res, next);
        expect(getNextCalled()).toBe(true);
        expect(getStatus()).toBe(200);
        expect(req.chatQuota).toEqual({ used: 51, limit: CHAT_MONTHLY_LIMIT });
        // Debe haber commit
        expect(pool.queries.some(q => /COMMIT/i.test(q.sql))).toBe(true);
    });

    test('cuota agotada → 429 CHAT_QUOTA_EXCEEDED con resets_at', async () => {
        const nextReset = new Date(Date.now() + 5 * 86400000);
        const pool = makePoolMock({
            row: {
                chat_addon: true,
                chat_consultas_mes: CHAT_MONTHLY_LIMIT,
                chat_consultas_reset_at: new Date(),
                next_reset: nextReset
            }
        });
        const { req, res, next, getNextCalled, getStatus, getPayload } = mockReqRes();
        await chatAddonGate(pool)(req, res, next);
        expect(getStatus()).toBe(429);
        expect(getPayload()).toMatchObject({
            error: 'CHAT_QUOTA_EXCEEDED',
            used: CHAT_MONTHLY_LIMIT,
            limit: CHAT_MONTHLY_LIMIT
        });
        expect(getPayload().resets_at).toBeDefined();
        expect(getNextCalled()).toBe(false);
    });

    test('reset_at caducado → resetea contador y deja pasar', async () => {
        // next_reset en el pasado (caducado hace 1 día)
        const expiredNextReset = new Date(Date.now() - 86400000);
        const pool = makePoolMock({
            row: {
                chat_addon: true,
                chat_consultas_mes: CHAT_MONTHLY_LIMIT, // estaba lleno
                chat_consultas_reset_at: new Date(Date.now() - 31 * 86400000),
                next_reset: expiredNextReset
            }
        });
        const { req, res, next, getNextCalled, getStatus } = mockReqRes();
        await chatAddonGate(pool)(req, res, next);
        // Tras reset, el contador es 0 → cuota disponible → next() llamado
        expect(getNextCalled()).toBe(true);
        expect(getStatus()).toBe(200);
        // Debe haber al menos un UPDATE con chat_consultas_mes = 0 (reset)
        expect(pool.queries.some(q => /chat_consultas_mes\s*=\s*0/i.test(q.sql))).toBe(true);
    });

    test('sin restauranteId → 401', async () => {
        const pool = makePoolMock({ row: {} });
        const req = {}; // sin restauranteId
        let statusCode = 200;
        let payload = null;
        const res = {
            status(c) { statusCode = c; return this; },
            json(b) { payload = b; return this; }
        };
        let nextCalled = false;
        await chatAddonGate(pool)(req, res, () => { nextCalled = true; });
        expect(statusCode).toBe(401);
        expect(payload).toMatchObject({ error: expect.stringContaining('restaurante') });
        expect(nextCalled).toBe(false);
    });
});
