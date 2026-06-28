/**
 * ============================================
 * tests/critical/balance-iva-soportado.test.js
 * ============================================
 *
 * CRITICAL (2026-06-28): el informe "IVA soportado del periodo"
 * (GET /api/balance/iva-soportado) debe ser la suma FIABLE del IVA de las
 * compras recibidas del mes, NO un número inflado.
 *
 * Contrato blindado:
 *   1. Un pedido recibido con iva_pct=21 y total=100 (sin envases) aporta 21,00.
 *   2. CLAVE FIABILIDAD: un pedido con un item 'ajuste' (envase) NO incluye el
 *      envase en la base imponible. total=110 con ajuste importe=10 → base 100 →
 *      aporta 21,00 (NO 23,10). Reproduce el IVA que el camarero confirma en el
 *      modal de recepción (baseNeta × iva%, sin envases).
 *   3. Envase de vuelta (ajuste negativo) suma a la base.
 *   4. Solo cuenta estado='recibido'.
 *
 * AISLAMIENTO: crear pedidos 'recibido' recalcula precio_medio del ingrediente y
 * escribe compras_diarias del mes (efectos globales). Para no contaminar a otros
 * tests en CI, este test usa un INGREDIENTE DESECHABLE propio y un MES FUTURO
 * (2099-01) que ningún otro test consulta. Estrategia de DELTA por robustez.
 *
 * @date 2026-06-28
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

// Mes futuro aislado: ningún otro test/seed asserta sobre 2099-01.
const MES = 1;
const ANO = 2099;
const FECHA = '2099-01-15';

async function getIvaSoportado(authToken) {
    const res = await request(API_URL)
        .get(`/api/balance/iva-soportado?mes=${MES}&ano=${ANO}`)
        .set('Origin', 'http://localhost:3001')
        .set('Authorization', `Bearer ${authToken}`);
    if (res.status !== 200) return null;
    return {
        iva: parseFloat(res.body.iva_soportado) || 0,
        num: parseInt(res.body.num_pedidos_con_iva) || 0
    };
}

async function crearPedidoRecibido(authToken, { total, iva_pct, ingredientes }) {
    const res = await request(API_URL)
        .post('/api/orders')
        .set('Origin', 'http://localhost:3001')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ proveedorId: null, fecha: FECHA, estado: 'recibido', total, iva_pct, ingredientes });
    return [200, 201].includes(res.status) ? res.body.id : null;
}

describe('IVA soportado del periodo — suma fiable (sin inflar por envases)', () => {
    let authToken;
    let ingId;
    const creados = [];

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) { console.warn('⚠️ No auth. Tests skipped.'); return; }

        // Ingrediente desechable: aísla el recálculo de precio_medio y compras.
        const nombre = `__test_iva_soportado_${Date.now()}`;
        const ingRes = await request(API_URL)
            .post('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ nombre, unidad: 'kg', precio: 1, cantidad_por_formato: 1 });
        if (![200, 201].includes(ingRes.status) || !ingRes.body?.id) {
            console.warn('⚠️ No se pudo crear ingrediente de test. Tests skipped.'); return;
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

    it('1. Pedido recibido iva_pct=21, total=100 (sin envases) → aporta 21,00', async () => {
        if (!authToken || !ingId) return;

        const antes = await getIvaSoportado(authToken);
        expect(antes).not.toBeNull();

        const id = await crearPedidoRecibido(authToken, {
            total: 100, iva_pct: 21,
            ingredientes: [{ ingredienteId: ingId, cantidad: 1, precioUnitario: 100 }]
        });
        expect(id).not.toBeNull();
        creados.push(id);

        const despues = await getIvaSoportado(authToken);
        // Delta del IVA = 100 × 21% = 21,00
        expect(despues.iva - antes.iva).toBeCloseTo(21, 2);
        expect(despues.num - antes.num).toBe(1);
    });

    it('2. FIABILIDAD: pedido con envase (ajuste) NO infla la base — total=110, ajuste=10 → aporta 21,00 (no 23,10)', async () => {
        if (!authToken || !ingId) return;

        const antes = await getIvaSoportado(authToken);

        const id = await crearPedidoRecibido(authToken, {
            total: 110, iva_pct: 21,
            ingredientes: [
                { ingredienteId: ingId, cantidad: 1, precioUnitario: 100 },
                // Envase/depósito como item 'ajuste' (mismo formato que recepción).
                { tipo: 'ajuste', concepto: 'Envase barril', importe: 10 }
            ]
        });
        expect(id).not.toBeNull();
        creados.push(id);

        const despues = await getIvaSoportado(authToken);
        const delta = despues.iva - antes.iva;
        // Base imponible = 110 − 10 (envase) = 100 → IVA = 21,00.
        // Si el envase NO se excluyera, saldría 110 × 21% = 23,10 (número falso).
        expect(delta).toBeCloseTo(21, 2);
        expect(delta).not.toBeCloseTo(23.1, 1);
    });

    it('3. Envase de vuelta (ajuste negativo) suma a la base — total=90, ajuste=-10 → aporta 21,00', async () => {
        if (!authToken || !ingId) return;

        const antes = await getIvaSoportado(authToken);

        const id = await crearPedidoRecibido(authToken, {
            total: 90, iva_pct: 21,
            ingredientes: [
                { ingredienteId: ingId, cantidad: 1, precioUnitario: 100 },
                { tipo: 'ajuste', concepto: 'Devolución envase', importe: -10 }
            ]
        });
        expect(id).not.toBeNull();
        creados.push(id);

        const despues = await getIvaSoportado(authToken);
        // Base imponible = 90 − (−10) = 100 → IVA = 21,00.
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
                ingredientes: [{ ingredienteId: ingId, cantidad: 1, precioUnitario: 200 }]
            });
        if ([200, 201].includes(res.status)) creados.push(res.body.id);

        const despues = await getIvaSoportado(authToken);
        // Un pedido pendiente no debe sumar nada al IVA soportado del periodo.
        expect(despues.iva - antes.iva).toBeCloseTo(0, 2);
    });

    it('5. FIABILIDAD: comida personal NO entra en la base — total=120 con línea personal=20 → aporta 21,00 (no 25,20)', async () => {
        if (!authToken || !ingId) return;

        const antes = await getIvaSoportado(authToken);

        const id = await crearPedidoRecibido(authToken, {
            total: 120, iva_pct: 21,
            ingredientes: [
                { ingredienteId: ingId, cantidad: 1, precioUnitario: 100 },
                // Línea de comida personal: cuenta en pedido.total pero NO es gasto
                // del restaurante → su IVA no es deducible, fuera de la base.
                { ingredienteId: ingId, cantidad: 1, precioUnitario: 20, personal: true }
            ]
        });
        expect(id).not.toBeNull();
        creados.push(id);

        const despues = await getIvaSoportado(authToken);
        const delta = despues.iva - antes.iva;
        // Base imponible = 120 − 20 (personal) = 100 → IVA = 21,00.
        // Sin restar lo personal saldría 120 × 21% = 25,20 (número falso).
        expect(delta).toBeCloseTo(21, 2);
        expect(delta).not.toBeCloseTo(25.2, 1);
    });
});
