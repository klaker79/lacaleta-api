/**
 * Unit tests para POST /webhooks/polar.
 *
 * Mockeamos polarService.verifyWebhook para no necesitar el secret real.
 * Mockeamos el pool de pg con un client que registra todas las queries.
 *
 * Cubrimos las 5 ramas críticas:
 *   1. Firma inválida → 401, no toca BBDD
 *   2. subscription.active con restaurante_id → INSERT subs + UPDATE chat_addon=true
 *   3. subscription.canceled → UPDATE chat_addon=false
 *   4. Sin metadata.restaurante_id → 200 ignored
 *   5. addon_type distinto a chat_ia → 200 ignored
 */

jest.mock('../../src/services/polarService');
const polarService = require('../../src/services/polarService');

const express = require('express');
const request = require('supertest');
const webhooksRoutesFactory = require('../../src/routes/webhooks.routes');

function makePool() {
    const queries = [];
    const client = {
        async query(sql, params) {
            queries.push({ sql, params });
            const trimmed = sql.trim().toUpperCase();
            if (trimmed.startsWith('BEGIN')) return { rows: [] };
            if (trimmed.startsWith('COMMIT')) return { rows: [] };
            if (trimmed.startsWith('ROLLBACK')) return { rows: [] };
            if (trimmed.startsWith('INSERT')) return { rowCount: 1 };
            if (trimmed.startsWith('UPDATE')) return { rowCount: 1 };
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

function buildApp(pool) {
    const app = express();
    app.use('/api', webhooksRoutesFactory(pool));
    return app;
}

describe('POST /webhooks/polar', () => {
    afterEach(() => jest.clearAllMocks());

    test('firma inválida → 401', async () => {
        polarService.verifyWebhook.mockImplementation(() => {
            throw new Error('invalid signature');
        });
        const pool = makePool();
        const app = buildApp(pool);

        const res = await request(app)
            .post('/api/webhooks/polar')
            .set('Content-Type', 'application/json')
            .send({ anything: true });

        expect(res.status).toBe(401);
        // No debe haber tocado BBDD
        expect(pool.queries.length).toBe(0);
    });

    test('subscription.active activa chat_addon e inserta auditoría', async () => {
        polarService.verifyWebhook.mockReturnValue({
            type: 'subscription.active',
            data: {
                id: 'sub_abc123',
                status: 'active',
                metadata: { restaurante_id: '5', addon_type: 'chat_ia' },
                customer: { id: 'cust_xyz' },
                currentPeriodEnd: '2026-06-10T00:00:00Z'
            }
        });
        const pool = makePool();
        const app = buildApp(pool);

        const res = await request(app)
            .post('/api/webhooks/polar')
            .set('Content-Type', 'application/json')
            .send({ raw: 'irrelevant — verify is mocked' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ received: true });

        // Debe haber INSERT en chat_addon_subscriptions con UNIQUE clause
        const inserts = pool.queries.filter(q =>
            /INSERT INTO chat_addon_subscriptions/i.test(q.sql)
        );
        expect(inserts.length).toBe(1);
        expect(inserts[0].params[0]).toBe(5);                 // restaurante_id
        expect(inserts[0].params[1]).toBe('sub_abc123');      // polar_subscription_id
        expect(inserts[0].params[3]).toBe('active');          // status

        // Debe haber UPDATE en restaurantes con chat_addon = true
        const updates = pool.queries.filter(q =>
            /UPDATE restaurantes\s+SET chat_addon = true/i.test(q.sql)
        );
        expect(updates.length).toBe(1);

        // Debe haber commit (no rollback)
        expect(pool.queries.some(q => /COMMIT/i.test(q.sql))).toBe(true);
        expect(pool.queries.some(q => /ROLLBACK/i.test(q.sql))).toBe(false);
    });

    test('subscription.canceled desactiva chat_addon', async () => {
        polarService.verifyWebhook.mockReturnValue({
            type: 'subscription.canceled',
            data: {
                id: 'sub_abc123',
                status: 'canceled',
                metadata: { restaurante_id: '5', addon_type: 'chat_ia' }
            }
        });
        const pool = makePool();
        const app = buildApp(pool);

        const res = await request(app)
            .post('/api/webhooks/polar')
            .set('Content-Type', 'application/json')
            .send({ x: 1 });

        expect(res.status).toBe(200);
        const updates = pool.queries.filter(q =>
            /UPDATE restaurantes SET chat_addon = false/i.test(q.sql)
        );
        expect(updates.length).toBe(1);
    });

    test('sin metadata.restaurante_id → 200 ignored, no toca BBDD', async () => {
        polarService.verifyWebhook.mockReturnValue({
            type: 'subscription.active',
            data: {
                id: 'sub_abc123',
                status: 'active',
                metadata: {} // huérfano
            }
        });
        const pool = makePool();
        const app = buildApp(pool);

        const res = await request(app)
            .post('/api/webhooks/polar')
            .set('Content-Type', 'application/json')
            .send({ x: 1 });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ no_restaurante: true });
        expect(pool.queries.filter(q => /INSERT/i.test(q.sql)).length).toBe(0);
    });

    test('addon_type distinto a chat_ia → ignored', async () => {
        polarService.verifyWebhook.mockReturnValue({
            type: 'subscription.active',
            data: {
                id: 'sub_xxx',
                status: 'active',
                metadata: { restaurante_id: '5', addon_type: 'plan_base' }
            }
        });
        const pool = makePool();
        const app = buildApp(pool);

        const res = await request(app)
            .post('/api/webhooks/polar')
            .set('Content-Type', 'application/json')
            .send({ x: 1 });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ other_product: true });
        expect(pool.queries.filter(q => /UPDATE restaurantes/i.test(q.sql)).length).toBe(0);
    });

    test('eventos no-subscription → ignored', async () => {
        polarService.verifyWebhook.mockReturnValue({
            type: 'checkout.created',
            data: { id: 'co_x' }
        });
        const pool = makePool();
        const app = buildApp(pool);

        const res = await request(app)
            .post('/api/webhooks/polar')
            .set('Content-Type', 'application/json')
            .send({ x: 1 });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ignored: true });
    });

    // ========================================================================
    // IDEMPOTENCIA — Polar reintenta el mismo evento si no le respondemos 2xx
    // rápido. El handler debe absorber duplicados sin efectos colaterales:
    // ON CONFLICT (polar_subscription_id) DO UPDATE en chat_addon_subscriptions
    // + UPDATE restaurantes idempotente (set chat_addon=true sigue siendo true).
    // ========================================================================
    describe('idempotencia (reintentos de Polar)', () => {
        test('mismo subscription.active enviado 2 veces — ambas 200, INSERT con ON CONFLICT, COMMITs', async () => {
            polarService.verifyWebhook.mockReturnValue({
                type: 'subscription.active',
                data: {
                    id: 'sub_dupe',
                    status: 'active',
                    metadata: { restaurante_id: '7', addon_type: 'chat_ia' },
                    customer: { id: 'cust_dupe' },
                    currentPeriodEnd: '2026-07-10T00:00:00Z'
                }
            });

            const pool = makePool();
            const app = buildApp(pool);

            const r1 = await request(app)
                .post('/api/webhooks/polar')
                .set('Content-Type', 'application/json')
                .send({ first: true });
            const r2 = await request(app)
                .post('/api/webhooks/polar')
                .set('Content-Type', 'application/json')
                .send({ retry: true });

            expect(r1.status).toBe(200);
            expect(r2.status).toBe(200);
            expect(r1.body).toMatchObject({ received: true });
            expect(r2.body).toMatchObject({ received: true });

            const inserts = pool.queries.filter(q =>
                /INSERT INTO chat_addon_subscriptions/i.test(q.sql)
            );
            // Ambas requests emiten su INSERT — la idempotencia la garantiza
            // ON CONFLICT en la BBDD real. Lo que NOSOTROS verificamos es:
            //   1. El INSERT siempre lleva ON CONFLICT DO UPDATE
            //   2. Ambos pasan sus params correctamente (mismo polar_subscription_id)
            //   3. No hay ROLLBACK en ninguna de las dos transacciones
            expect(inserts.length).toBe(2);
            inserts.forEach(ins => {
                expect(ins.sql).toMatch(/ON CONFLICT \(polar_subscription_id\) DO UPDATE/i);
                expect(ins.params[1]).toBe('sub_dupe');
            });

            // Ambas transacciones deben terminar en COMMIT, ninguna en ROLLBACK
            const commits = pool.queries.filter(q => /^\s*COMMIT/i.test(q.sql));
            const rollbacks = pool.queries.filter(q => /^\s*ROLLBACK/i.test(q.sql));
            expect(commits.length).toBe(2);
            expect(rollbacks.length).toBe(0);

            // Y ambas dispararon UPDATE chat_addon=true (idempotente)
            const updatesActivos = pool.queries.filter(q =>
                /UPDATE restaurantes\s+SET chat_addon = true/i.test(q.sql)
            );
            expect(updatesActivos.length).toBe(2);
        });

        test('flip-flop active → canceled → active genera SQL coherente y NO duplica filas', async () => {
            const pool = makePool();
            const app = buildApp(pool);

            // 1) Activación inicial
            polarService.verifyWebhook.mockReturnValueOnce({
                type: 'subscription.active',
                data: {
                    id: 'sub_flip',
                    status: 'active',
                    metadata: { restaurante_id: '9', addon_type: 'chat_ia' },
                    customer: { id: 'cust_flip' },
                    currentPeriodEnd: '2026-07-15T00:00:00Z'
                }
            });
            const r1 = await request(app).post('/api/webhooks/polar')
                .set('Content-Type', 'application/json').send({ x: 1 });

            // 2) Cancelación
            polarService.verifyWebhook.mockReturnValueOnce({
                type: 'subscription.canceled',
                data: {
                    id: 'sub_flip',
                    status: 'canceled',
                    metadata: { restaurante_id: '9', addon_type: 'chat_ia' }
                }
            });
            const r2 = await request(app).post('/api/webhooks/polar')
                .set('Content-Type', 'application/json').send({ x: 2 });

            // 3) Reactivación
            polarService.verifyWebhook.mockReturnValueOnce({
                type: 'subscription.active',
                data: {
                    id: 'sub_flip',
                    status: 'active',
                    metadata: { restaurante_id: '9', addon_type: 'chat_ia' },
                    customer: { id: 'cust_flip' },
                    currentPeriodEnd: '2026-08-15T00:00:00Z'
                }
            });
            const r3 = await request(app).post('/api/webhooks/polar')
                .set('Content-Type', 'application/json').send({ x: 3 });

            expect(r1.status).toBe(200);
            expect(r2.status).toBe(200);
            expect(r3.status).toBe(200);

            // 3 INSERTs (todos con ON CONFLICT — la BBDD real solo persiste 1 fila)
            const inserts = pool.queries.filter(q =>
                /INSERT INTO chat_addon_subscriptions/i.test(q.sql)
            );
            expect(inserts.length).toBe(3);
            inserts.forEach(ins => expect(ins.params[1]).toBe('sub_flip'));

            // chat_addon: true, false, true (en orden)
            const updates = pool.queries.filter(q =>
                /UPDATE restaurantes\s+SET chat_addon/i.test(q.sql)
            );
            expect(updates.length).toBe(3);
            expect(updates[0].sql).toMatch(/chat_addon = true/i);
            expect(updates[1].sql).toMatch(/chat_addon = false/i);
            expect(updates[2].sql).toMatch(/chat_addon = true/i);

            // Sin rollbacks
            expect(pool.queries.some(q => /ROLLBACK/i.test(q.sql))).toBe(false);
        });

        test('subscription.created y subscription.active del mismo sub_id NO se pisan: ambos llevan ON CONFLICT', async () => {
            // Polar suele mandar created seguido inmediato de active. Verificamos
            // que ambos producen INSERTs con ON CONFLICT (la fila no se duplica).
            const pool = makePool();
            const app = buildApp(pool);

            polarService.verifyWebhook.mockReturnValueOnce({
                type: 'subscription.created',
                data: {
                    id: 'sub_seq',
                    status: 'active',
                    metadata: { restaurante_id: '11', addon_type: 'chat_ia' },
                    customer: { id: 'cust_seq' },
                    currentPeriodEnd: '2026-06-01T00:00:00Z'
                }
            });
            polarService.verifyWebhook.mockReturnValueOnce({
                type: 'subscription.active',
                data: {
                    id: 'sub_seq',
                    status: 'active',
                    metadata: { restaurante_id: '11', addon_type: 'chat_ia' },
                    customer: { id: 'cust_seq' },
                    currentPeriodEnd: '2026-06-01T00:00:00Z'
                }
            });

            await request(app).post('/api/webhooks/polar')
                .set('Content-Type', 'application/json').send({ x: 1 });
            await request(app).post('/api/webhooks/polar')
                .set('Content-Type', 'application/json').send({ x: 2 });

            const inserts = pool.queries.filter(q =>
                /INSERT INTO chat_addon_subscriptions/i.test(q.sql)
            );
            expect(inserts.length).toBe(2);
            inserts.forEach(ins => {
                expect(ins.sql).toMatch(/ON CONFLICT \(polar_subscription_id\) DO UPDATE/i);
                expect(ins.params[1]).toBe('sub_seq');
            });
        });
    });
});
