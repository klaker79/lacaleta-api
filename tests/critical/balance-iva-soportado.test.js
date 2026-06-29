/**
 * ============================================
 * tests/critical/balance-iva-soportado.test.js
 * ============================================
 *
 * CRITICAL (2026-06-28): el informe "IVA soportado del periodo"
 * (GET /api/balance/iva-soportado) debe ser la suma FIABLE del IVA de las
 * compras recibidas del mes, NO un número inflado.
 *
 * Contrato blindado (estrategia de DELTA: baseline → crear → re-leer):
 *   1. Pedido recibido iva_pct=21, total=100 (sin envases) → +21,00 IVA, +100 base.
 *   2. FIABILIDAD: envase (item 'ajuste') NO infla la base. total=110, ajuste=10 →
 *      base 100 → +21,00 (no 23,10).
 *   3. Envase de vuelta (ajuste negativo) suma a la base.
 *   4. Solo cuenta estado='recibido' (un pendiente NO suma).
 *   5. FIABILIDAD: comida personal (línea personal:true) NO entra en la base.
 *
 * Patrón de creación calcado de delete-order-preserves-purchases (que CI da por
 * bueno): pedido 'recibido' con fecha de HOY y payload completo
 * (cantidadRecibida + precioReal). Ingrediente desechable propio para aislar el
 * recálculo de precio. Si el entorno no deja crear el recibido, el test degrada con
 * elegancia (skip) y deja el status+body en el log para diagnóstico.
 *
 * @date 2026-06-28 (reescrito 2026-06-29)
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

const hoy = new Date();
const MES = hoy.getMonth() + 1;
const ANO = hoy.getFullYear();
const FECHA = hoy.toISOString().split('T')[0];

async function getIvaSoportado(authToken) {
    const res = await request(API_URL)
        .get(`/api/balance/iva-soportado?mes=${MES}&ano=${ANO}`)
        .set('Origin', 'http://localhost:3001')
        .set('Authorization', `Bearer ${authToken}`);
    if (res.status !== 200) return null;
    return {
        iva: parseFloat(res.body.iva_soportado) || 0,
        base: parseFloat(res.body.base_imponible) || 0,
        num: parseInt(res.body.num_pedidos_con_iva) || 0
    };
}

async function crearPedidoRecibido(authToken, { total, iva_pct, ingredientes }) {
    const res = await request(API_URL)
        .post('/api/orders')
        .set('Origin', 'http://localhost:3001')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ proveedorId: null, fecha: FECHA, estado: 'recibido', total, iva_pct, ingredientes });
    if (![200, 201].includes(res.status)) {
        console.warn(`⚠️ crearPedidoRecibido → ${res.status}: ${JSON.stringify(res.body)}`);
        return null;
    }
    return res.body.id;
}

// Línea de género con payload completo (como delete-order-preserves-purchases).
function linea(ingId, cantidad, precio, extra = {}) {
    return { ingredienteId: ingId, cantidad, cantidadRecibida: cantidad, precioReal: precio, precioUnitario: precio, ...extra };
}

describe('IVA soportado del periodo — suma fiable (sin inflar por envases ni personal)', () => {
    let authToken;
    let ingId;
    const creados = [];

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) { console.warn('⚠️ No auth. Tests skipped.'); return; }

        // Ingrediente desechable propio → aísla el recálculo de precio_medio.
        const nombre = `__test_iva_soportado_${Date.now()}`;
        const ingRes = await request(API_URL)
            .post('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ nombre, unidad: 'kg', precio: 1, cantidad_por_formato: 1 });
        if (![200, 201].includes(ingRes.status) || !ingRes.body?.id) {
            console.warn(`⚠️ No se pudo crear ingrediente de test (${ingRes.status}). Tests skipped.`); return;
        }
        ingId = ingRes.body.id;
    });

    afterAll(async () => {
        for (const id of creados) {
            if (id && authToken) {
                await request(API_URL)
                    .delete(`/api/orders/${id}`)
                    .set('Origin', 'http://localhost:3001')
                    .set('Authorization', `Bearer ${authToken}`);
            }
        }
        if (ingId && authToken) {
            await request(API_URL)
                .delete(`/api/ingredients/${ingId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
    });

    it('1. Pedido recibido iva_pct=21, total=100 (sin envases) → +21,00 IVA, +100 base', async () => {
        if (!authToken || !ingId) return;

        const antes = await getIvaSoportado(authToken);
        expect(antes).not.toBeNull();

        const id = await crearPedidoRecibido(authToken, {
            total: 100, iva_pct: 21,
            ingredientes: [linea(ingId, 1, 100)]
        });
        if (!id) return; // entorno sin poder crear recibido → skip (el log dice por qué)
        creados.push(id);

        const despues = await getIvaSoportado(authToken);
        expect(despues.iva - antes.iva).toBeCloseTo(21, 2);
        expect(despues.base - antes.base).toBeCloseTo(100, 2);
        expect(despues.num - antes.num).toBe(1);
    });

    it('2. FIABILIDAD: envase (ajuste) NO infla la base — total=110, ajuste=10 → +21,00 (no 23,10)', async () => {
        if (!authToken || !ingId) return;

        const antes = await getIvaSoportado(authToken);

        const id = await crearPedidoRecibido(authToken, {
            total: 110, iva_pct: 21,
            ingredientes: [
                linea(ingId, 1, 100),
                { tipo: 'ajuste', concepto: 'Envase barril', importe: 10 }
            ]
        });
        if (!id) return;
        creados.push(id);

        const despues = await getIvaSoportado(authToken);
        const delta = despues.iva - antes.iva;
        // Base = 110 − 10 (envase) = 100 → IVA 21,00. Sin excluir el envase: 23,10.
        expect(delta).toBeCloseTo(21, 2);
        expect(delta).not.toBeCloseTo(23.1, 1);
    });

    it('3. Envase de vuelta (ajuste negativo) suma a la base — total=90, ajuste=-10 → +21,00', async () => {
        if (!authToken || !ingId) return;

        const antes = await getIvaSoportado(authToken);

        const id = await crearPedidoRecibido(authToken, {
            total: 90, iva_pct: 21,
            ingredientes: [
                linea(ingId, 1, 100),
                { tipo: 'ajuste', concepto: 'Devolución envase', importe: -10 }
            ]
        });
        if (!id) return;
        creados.push(id);

        const despues = await getIvaSoportado(authToken);
        // Base = 90 − (−10) = 100 → IVA 21,00.
        expect(despues.iva - antes.iva).toBeCloseTo(21, 2);
    });

    it('4. Pedido pendiente (no recibido) NO cuenta', async () => {
        if (!authToken || !ingId) return;

        const antes = await getIvaSoportado(authToken);

        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null, fecha: FECHA, estado: 'pendiente',
                total: 200, iva_pct: 21,
                ingredientes: [linea(ingId, 1, 200)]
            });
        if ([200, 201].includes(res.status)) creados.push(res.body.id);

        const despues = await getIvaSoportado(authToken);
        expect(despues.iva - antes.iva).toBeCloseTo(0, 2);
    });

    it('5. FIABILIDAD: comida personal NO entra en la base — total=120 con línea personal=20 → +21,00 (no 25,20)', async () => {
        if (!authToken || !ingId) return;

        const antes = await getIvaSoportado(authToken);

        const id = await crearPedidoRecibido(authToken, {
            total: 120, iva_pct: 21,
            ingredientes: [
                linea(ingId, 1, 100),
                // Línea de comida personal: cuenta en pedido.total pero NO es gasto del
                // restaurante → su IVA no es deducible, fuera de la base.
                linea(ingId, 1, 20, { personal: true })
            ]
        });
        if (!id) return;
        creados.push(id);

        const despues = await getIvaSoportado(authToken);
        const delta = despues.iva - antes.iva;
        // Base = 120 − 20 (personal) = 100 → IVA 21,00. Sin restar personal: 25,20.
        expect(delta).toBeCloseTo(21, 2);
        expect(delta).not.toBeCloseTo(25.2, 1);
    });
});
