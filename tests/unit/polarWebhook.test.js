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
});
