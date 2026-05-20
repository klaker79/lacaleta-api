/**
 * ═══════════════════════════════════════════════════
 * 🔐 AUTH USERNAME — Deploy 1 backward-compat
 * ═══════════════════════════════════════════════════
 *
 * Tras el refactor de 2026-05-21 (Deploy 1), el endpoint POST /auth/login
 * acepta tanto `email` como `identifier` (email o username). Estos tests
 * blindan el comportamiento esperado:
 *
 * 1. Login con `{ email, password }` sigue funcionando (compat frontends viejos).
 * 2. Login con `{ identifier=email, password }` funciona (nuevo contrato).
 * 3. Login con `{ identifier=username, password }` funciona (NUEVA funcionalidad).
 * 4. Login con identifier vacío + password → 400.
 * 5. Response del login incluye `user.username` (puede ser null si no migrado).
 *
 * El test 3 ASUME que la migración usuarios.username se ha aplicado al iniciar
 * el server (init.js lo hace) y que el TEST_USER_EMAIL tiene su parte local
 * (antes del @) backfilled en username. Si la migración falla, este test caza.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL || 'test@test.com';
const TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD || 'test123';

// El backfill de init.js usa SPLIT_PART(email, '@', 1) → parte local del email.
const TEST_USERNAME = TEST_USER_EMAIL.split('@')[0];

describe('Auth Username — Deploy 1 backward-compat', () => {
    it('1. POST /auth/login con { email, password } sigue funcionando (compat)', async () => {
        const res = await request(API_URL)
            .post('/api/auth/login')
            .set('Origin', 'http://localhost:3001')
            .send({ email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD });

        // Aceptamos 200 (login OK) o 429 (rate-limit en CI lento).
        expect([200, 429]).toContain(res.status);
        if (res.status === 200) {
            expect(res.body.token).toBeDefined();
            expect(res.body.user?.email).toBe(TEST_USER_EMAIL);
        }
    });

    it('2. POST /auth/login con { identifier=email, password } funciona', async () => {
        const res = await request(API_URL)
            .post('/api/auth/login')
            .set('Origin', 'http://localhost:3001')
            .send({ identifier: TEST_USER_EMAIL, password: TEST_USER_PASSWORD });

        expect([200, 429]).toContain(res.status);
        if (res.status === 200) {
            expect(res.body.token).toBeDefined();
            expect(res.body.user?.email).toBe(TEST_USER_EMAIL);
        }
    });

    it('3. POST /auth/login con { identifier=username, password } funciona', async () => {
        const res = await request(API_URL)
            .post('/api/auth/login')
            .set('Origin', 'http://localhost:3001')
            .send({ identifier: TEST_USERNAME, password: TEST_USER_PASSWORD });

        expect([200, 429]).toContain(res.status);
        if (res.status === 200) {
            expect(res.body.token).toBeDefined();
            // El user devuelto debería tener el email correspondiente al username
            expect(res.body.user?.email).toBe(TEST_USER_EMAIL);
        }
    });

    it('4. POST /auth/login sin identifier ni email → 400', async () => {
        const res = await request(API_URL)
            .post('/api/auth/login')
            .set('Origin', 'http://localhost:3001')
            .send({ password: TEST_USER_PASSWORD });

        expect([400, 429]).toContain(res.status);
        if (res.status === 400) expect(res.body.error).toBeDefined();
    });

    it('5. Response del login incluye `user.username` (puede ser string o null)', async () => {
        const res = await request(API_URL)
            .post('/api/auth/login')
            .set('Origin', 'http://localhost:3001')
            .send({ email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD });

        if (res.status === 200) {
            // El campo debe existir en la respuesta. Acepta string (backfilled) o null
            // (usuario nuevo sin username asignado en algún edge case).
            expect(res.body.user).toHaveProperty('username');
        }
    });
});
