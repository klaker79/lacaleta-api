/**
 * POST /inventory/consolidate — la merma del recuento debe ser VISIBLE.
 *
 * Había dos tablas de merma y solo una se leía:
 *   · `mermas`                    ← POST /mermas (modal "merma rápida").
 *                                   La leen los informes, Omnes y el informe mensual.
 *   · `inventory_adjustments_v2`  ← escribía SOLO este endpoint... y nadie la leía.
 *
 * Consecuencia: todo lo que se perdía al cuadrar el inventario físico desaparecía
 * de los informes (551 registros invisibles en La Nave 5). Ahora la pérdida se
 * refleja también en `mermas`, sin tocar ninguna consulta de lectura.
 *
 * Lo que blindan estos tests:
 *   1. Un ajuste NEGATIVO deja fila en `mermas` con cantidad positiva y su valor.
 *   2. Un ajuste POSITIVO no es merma (apareció género, no se perdió).
 *   3. El bloque de ajustes NO toca el stock: de eso se encarga `finalStock`.
 *      Descontar aquí dejaría el inventario recién contado a la mitad.
 *   4. `inventory_adjustments_v2` se sigue escribiendo (es el libro del recuento).
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../src/middleware/auth', () => ({
    authMiddleware: (req, _res, next) => {
        req.restauranteId = 3;
        req.user = { userId: 7 };
        next();
    }
}));

const inventoryRoutesFactory = require('../../src/routes/inventory.routes');

// BERBERECHOS: 16,32 €/kg de media de compras reales.
const INGREDIENTE = {
    id: 45, nombre: 'BERBERECHOS', unidad: 'kg',
    precio: 16.32, cantidad_por_formato: 1, precio_fijado: false,
    precio_medio_compra: 16.32
};

function makePool({ ingredientes = [INGREDIENTE] } = {}) {
    const queries = [];
    const client = {
        async query(sql, params) {
            queries.push({ sql, params });
            const s = sql.trim().toUpperCase();
            if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
            // Carga de datos del ingrediente para nombre/unidad/precio.
            if (s.startsWith('SELECT') && sql.includes('precio_medio_compra')) return { rows: ingredientes };
            if (s.startsWith('INSERT')) return { rowCount: 1, rows: [] };
            if (s.startsWith('UPDATE')) return { rowCount: 1, rows: [{ id: 45 }] };
            return { rows: [] };
        },
        release() { /* noop */ }
    };
    return { queries, async connect() { return client; }, async query(sql, params) { return client.query(sql, params); } };
}

function buildApp(pool) {
    const app = express();
    app.use(express.json());
    app.use('/api', inventoryRoutesFactory(pool));
    return app;
}

const insertsEn = (queries, tabla) =>
    queries.filter(q => /^\s*INSERT/i.test(q.sql) && q.sql.includes(tabla));

describe('POST /inventory/consolidate — pérdida del recuento', () => {
    test('un ajuste negativo deja la merma registrada en `mermas`', async () => {
        const pool = makePool();
        const res = await request(buildApp(pool))
            .post('/api/inventory/consolidate')
            .send({
                adjustments: [{ ingrediente_id: 45, cantidad: -11.15, motivo: 'Caduco', notas: '' }],
                snapshots: [],
                finalStock: []
            });

        expect(res.status).toBe(200);

        const mermas = insertsEn(pool.queries, 'INTO mermas');
        expect(mermas).toHaveLength(1);

        // La merma se guarda en POSITIVO (cantidad perdida), no con el signo del ajuste.
        const p = mermas[0].params;
        expect(p[0]).toBe(45);
        expect(p[1]).toBe('BERBERECHOS');
        expect(p[2]).toBeCloseTo(11.15, 2);
        expect(p[3]).toBe('kg');
        expect(p[4]).toBeCloseTo(11.15 * 16.32, 2);  // valor_perdida
        expect(p[5]).toBe('Caduco');                  // motivo, tal cual lo eligió el usuario
        expect(p[8]).toBe(3);                         // restaurante_id — multi-tenant
    });

    test('un ajuste positivo NO es merma (apareció género, no se perdió)', async () => {
        const pool = makePool();
        await request(buildApp(pool))
            .post('/api/inventory/consolidate')
            .send({ adjustments: [{ ingrediente_id: 45, cantidad: 4.2, motivo: 'Error Inventario' }], snapshots: [], finalStock: [] });

        expect(insertsEn(pool.queries, 'INTO mermas')).toHaveLength(0);
        // Pero el libro del recuento sí lo recoge.
        expect(insertsEn(pool.queries, 'inventory_adjustments_v2')).toHaveLength(1);
    });

    test('sigue escribiendo el libro del recuento además de la merma', async () => {
        const pool = makePool();
        await request(buildApp(pool))
            .post('/api/inventory/consolidate')
            .send({ adjustments: [{ ingrediente_id: 45, cantidad: -3, motivo: 'Caduco' }], snapshots: [], finalStock: [] });

        expect(insertsEn(pool.queries, 'inventory_adjustments_v2')).toHaveLength(1);
        expect(insertsEn(pool.queries, 'INTO mermas')).toHaveLength(1);
    });

    // El bug que este espejo podría haber introducido: descontar dos veces.
    test('NO descuenta stock al registrar la merma (lo hace finalStock)', async () => {
        const pool = makePool();
        await request(buildApp(pool))
            .post('/api/inventory/consolidate')
            .send({ adjustments: [{ ingrediente_id: 45, cantidad: -11.15, motivo: 'Caduco' }], snapshots: [], finalStock: [] });

        const restas = pool.queries.filter(q => /stock_actual\s*=\s*GREATEST\(0,\s*stock_actual\s*-/i.test(q.sql));
        expect(restas).toHaveLength(0);
    });

    test('un ingrediente de otro tenant o borrado no rompe el recuento', async () => {
        // El SELECT filtra por restaurante_id: el ingrediente no se resuelve.
        const pool = makePool({ ingredientes: [] });
        const res = await request(buildApp(pool))
            .post('/api/inventory/consolidate')
            .send({ adjustments: [{ ingrediente_id: 999, cantidad: -5, motivo: 'Caduco' }], snapshots: [], finalStock: [] });

        expect(res.status).toBe(200);
        expect(insertsEn(pool.queries, 'INTO mermas')).toHaveLength(0);
        expect(insertsEn(pool.queries, 'inventory_adjustments_v2')).toHaveLength(1);
    });
});
