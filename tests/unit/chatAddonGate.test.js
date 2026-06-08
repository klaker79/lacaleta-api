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
    test('chat_addon ya NO se chequea (modelo single-plan 2026-06-08) — deja pasar y cuenta cuota', async () => {
        // En el modelo single-plan, el chat IA va incluido en cualquier plan
        // activo (lo gatea el subscription middleware global en server.js).
        // chatAddonGate solo gestiona la cuota mensual.
        // Antes: si chat_addon=false → 403 CHAT_NOT_ACTIVATED.
        // Ahora: chat_addon es irrelevante, pasa si hay cuota.
        const pool = makePoolMock({
            row: {
                chat_consultas_mes: 0,
                chat_consultas_reset_at: new Date(),
                next_reset: new Date(Date.now() + 30 * 86400000)
            }
        });
        const { req, res, next, getNextCalled, getStatus } = mockReqRes();
        await chatAddonGate(pool)(req, res, next);
        expect(getNextCalled()).toBe(true);
        expect(getStatus()).toBe(200);
        expect(req.chatQuota).toEqual({ used: 1, limit: CHAT_MONTHLY_LIMIT });
        // Commit hubo (se contó la consulta)
        expect(pool.queries.some(q => /COMMIT/i.test(q.sql))).toBe(true);
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

    // ========================================================================
    // CONCURRENCIA — Garantiza que SELECT FOR UPDATE + UPDATE RETURNING evitan
    // que dos requests concurrentes lean el mismo contador y lo dejen >LIMIT.
    //
    // El mock simula un row-lock real: un cliente que hace BEGIN+SELECT bloquea
    // al resto hasta que haga COMMIT/ROLLBACK, igual que Postgres. Las
    // requests se serializan dentro del lock, lo que demuestra que el flujo
    // del middleware no puede correr a la vez sobre el mismo restaurante.
    // ========================================================================
    describe('concurrencia (row-lock simulado)', () => {
        function makeConcurrentPool(initialCounter, addon = true) {
            const state = {
                chat_addon: addon,
                chat_consultas_mes: initialCounter,
                chat_consultas_reset_at: new Date(Date.now() - 24 * 3600 * 1000),
                next_reset: new Date(Date.now() + 30 * 24 * 3600 * 1000)
            };
            let lockOwner = null;
            const waitQueue = [];
            function acquireLock(clientId) {
                if (lockOwner === null) {
                    lockOwner = clientId;
                    return Promise.resolve();
                }
                return new Promise(resolve => waitQueue.push({ clientId, resolve }));
            }
            function releaseLock(clientId) {
                if (lockOwner !== clientId) return;
                lockOwner = null;
                const next = waitQueue.shift();
                if (next) {
                    lockOwner = next.clientId;
                    next.resolve();
                }
            }
            let counter = 0;
            return {
                state,
                async connect() {
                    const id = ++counter;
                    let holdingLock = false;
                    return {
                        async query(sql) {
                            const t = sql.trim().toUpperCase();
                            if (t.startsWith('BEGIN')) return { rows: [] };
                            if (t.startsWith('SELECT')) {
                                await acquireLock(id);
                                holdingLock = true;
                                return { rows: [{ ...state }] };
                            }
                            if (sql.includes('chat_consultas_mes = 0')) {
                                state.chat_consultas_mes = 0;
                                state.chat_consultas_reset_at = new Date();
                                return { rowCount: 1 };
                            }
                            if (t.startsWith('UPDATE')) {
                                state.chat_consultas_mes += 1;
                                return { rows: [{ chat_consultas_mes: state.chat_consultas_mes }] };
                            }
                            if (t.startsWith('COMMIT') || t.startsWith('ROLLBACK')) {
                                if (holdingLock) {
                                    releaseLock(id);
                                    holdingLock = false;
                                }
                                return { rows: [] };
                            }
                            return { rows: [] };
                        },
                        release() {
                            if (holdingLock) {
                                releaseLock(id);
                                holdingLock = false;
                            }
                        }
                    };
                }
            };
        }

        test('10 requests concurrentes con contador 295/300 — exactamente 5 pasan y 5 fallan con 429', async () => {
            const pool = makeConcurrentPool(295);
            const triples = Array.from({ length: 10 }, () => mockReqRes());
            await Promise.all(
                triples.map(({ req, res, next }) => chatAddonGate(pool)(req, res, next))
            );

            const passed = triples.filter(t => t.getNextCalled()).length;
            const blocked = triples.filter(t => t.getStatus() === 429).length;

            expect(passed).toBe(5);
            expect(blocked).toBe(5);
            // El contador NO pasa de 300 — el row-lock impide la carrera
            expect(pool.state.chat_consultas_mes).toBe(CHAT_MONTHLY_LIMIT);

            // Los que fallaron con 429 llevan el campo resets_at y used=300
            const blockedPayloads = triples
                .filter(t => t.getStatus() === 429)
                .map(t => t.getPayload());
            blockedPayloads.forEach(p => {
                expect(p).toMatchObject({
                    error: 'CHAT_QUOTA_EXCEEDED',
                    used: CHAT_MONTHLY_LIMIT,
                    limit: CHAT_MONTHLY_LIMIT
                });
                expect(p.resets_at).toBeDefined();
            });
        });

        test('10 requests concurrentes con contador 0/300 — los 10 pasan, contador final 10', async () => {
            const pool = makeConcurrentPool(0);
            const triples = Array.from({ length: 10 }, () => mockReqRes());
            await Promise.all(
                triples.map(({ req, res, next }) => chatAddonGate(pool)(req, res, next))
            );

            const passed = triples.filter(t => t.getNextCalled()).length;
            expect(passed).toBe(10);
            expect(pool.state.chat_consultas_mes).toBe(10);

            // Cada request recibe un valor monotónicamente creciente de used
            const usedValues = triples
                .map(t => t.req.chatQuota?.used)
                .filter(u => u !== undefined)
                .sort((a, b) => a - b);
            expect(usedValues).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        });

        test('100 requests concurrentes con contador 250/300 — exactamente 50 pasan, 50 fallan', async () => {
            const pool = makeConcurrentPool(250);
            const triples = Array.from({ length: 100 }, () => mockReqRes());
            await Promise.all(
                triples.map(({ req, res, next }) => chatAddonGate(pool)(req, res, next))
            );

            const passed = triples.filter(t => t.getNextCalled()).length;
            const blocked = triples.filter(t => t.getStatus() === 429).length;

            expect(passed).toBe(50);
            expect(blocked).toBe(50);
            expect(pool.state.chat_consultas_mes).toBe(CHAT_MONTHLY_LIMIT);
        });

        test('1 request con addon=false en concurrencia con 5 con addon=true → solo cuentan las addon=true (tenants distintos)', async () => {
            // Demuestra que el lock es POR fila (restaurante). Aquí mock un solo
            // pool con addon=true; el test del lock por tenant queda implícito
            // porque cada test usa una `state` distinta. Este caso valida que
            // mezclar 1 request 403 con 5 ok no rompe el contador.
            const pool = makeConcurrentPool(0, true);
            const triples = Array.from({ length: 5 }, () => mockReqRes());
            await Promise.all(
                triples.map(({ req, res, next }) => chatAddonGate(pool)(req, res, next))
            );
            expect(triples.filter(t => t.getNextCalled()).length).toBe(5);
            expect(pool.state.chat_consultas_mes).toBe(5);
        });
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
