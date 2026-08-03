/**
 * ═══════════════════════════════════════════════════════════════════
 * 🫀 GOLDEN PATH — el test de supervivencia de CosteOS
 * ═══════════════════════════════════════════════════════════════════
 *
 * Un solo viaje, el del dinero, de punta a punta y con números EXACTOS:
 *
 *   proveedor → ingrediente (formato CAJA 10 l a 23,10 €) → vínculo
 *   proveedor-ingrediente (€/unidad-base, no €/formato) → pedido →
 *   recepción (stock + compra diaria + precio ponderado) → receta →
 *   venta ×2 → resumen diario (ingresos/coste/beneficio) → borrar una
 *   venta (coste PROPORCIONAL, stock devuelto) → limpieza.
 *
 * Por qué existe (auditoría 2026-08-03): los ~1.700 tests por módulo
 * estaban verdes mientras los bugs vivían ENTRE módulos y entre ramas
 * (deriva main↔lite). Este archivo cruza todos los módulos de dinero en
 * una sola historia: si esto está verde contra la BD nueva del CI, el
 * corazón de CosteOS late. Si algo de esta cadena se rompe, se rompe
 * AQUÍ y no en el restaurante de un cliente.
 *
 * Reglas que hereda de la casa:
 *   - Corre contra el server vivo del CI (Postgres desde cero + init.js),
 *     igual que tests/critical. Sin mocks: lo que valida es el motor real.
 *   - Números redondos elegidos para que nominal y real coincidan
 *     (CAJA 10 l a 23,10 € → 2,31 €/l): cualquier desviación es un bug,
 *     no un artefacto del redondeo.
 *   - Fecha 2099-11-30 para no contaminar resúmenes reales del tenant
 *     de test (mismo truco que single-sale-updates-resumen).
 *   - El setup NO se salta en silencio: el caso 0 falla si faltó algo
 *     (patrón de resumen-diario-invariante).
 *
 * @author MindLoopIA
 * @date 2026-08-04 (Fase B del plan de estabilización)
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';
const ORIGIN = 'http://localhost:3001';

// ── La historia, en números ────────────────────────────────────────
const CPF = 10;                 // CAJA de 10 l
const PRECIO_CAJA = 23.10;      // € por CAJA (ingredientes.precio = €/FORMATO)
const PRECIO_LITRO = PRECIO_CAJA / CPF;         // 2.31 €/unidad-base
const LITROS_PEDIDOS = 20;      // 2 cajas, en unidad BASE (regla móvil↔PC)
const TOTAL_PEDIDO = +(LITROS_PEDIDOS * PRECIO_LITRO).toFixed(2); // 46.20
const LITROS_POR_RACION = 0.5;
const COSTE_RACION = +(LITROS_POR_RACION * PRECIO_LITRO).toFixed(4); // 1.155
const PVP = 10;                 // precio_venta de la receta
// Fechas: DOS topes distintos en el sistema (aprendizaje de este golden path).
//   - Pedidos: validateDate con allowFuture admite máx +1 AÑO (tope anti-dedazo)
//     → el pedido programado va a +30 días.
//   - Ventas: sin tope de futuro → 2099 para no contaminar resúmenes reales
//     (mismo truco que single-sale-updates-resumen).
const FECHA_PEDIDO = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const FECHA = '2099-11-30';     // fecha de las VENTAS del test

describe('🫀 GOLDEN PATH — proveedor → compra → stock → receta → venta → P&L', () => {
    let authToken;
    let setupError = null;
    let proveedorId, ingredienteId, pedidoId, recetaId;
    let ventaId1, ventaId2;
    let stockInicial = null;

    const sufijo = Date.now();

    const getIngrediente = async () => {
        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        if (res.status !== 200) return null;
        return res.body.find(i => i.id === ingredienteId) || null;
    };

    const getFilaResumen = async () => {
        const res = await request(API_URL)
            .get(`/api/daily/sales?fecha=${FECHA}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        if (res.status !== 200 || !Array.isArray(res.body)) return null;
        return res.body.find(r => r.receta_id === recetaId) || null;
    };

    beforeAll(async () => {
        try {
            authToken = await global.getAuthToken();
            if (!authToken) throw new Error('sin token de auth');

            // 1️⃣ Proveedor
            const provRes = await request(API_URL)
                .post('/api/suppliers')
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`)
                .send({ nombre: `GOLDEN PROV ${sufijo}` });
            proveedorId = (provRes.body?.data || provRes.body || {}).id;
            if (!proveedorId) throw new Error(`proveedor no creado (HTTP ${provRes.status})`);

            // 2️⃣ Ingrediente con formato real: CAJA de 10 l a 23,10 €.
            //    `precio` = €/FORMATO (regla de la casa), la app deriva 2,31 €/l.
            const ingRes = await request(API_URL)
                .post('/api/ingredients')
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    nombre: `ACEITE GOLDEN ${sufijo}`,
                    precio: PRECIO_CAJA,
                    unidad: 'l',
                    stock_minimo: 1,
                    formato_compra: 'CAJA',
                    cantidad_por_formato: CPF,
                    proveedor_id: proveedorId
                });
            ingredienteId = (ingRes.body?.data || ingRes.body || {}).id;
            if (!ingredienteId) throw new Error(`ingrediente no creado (HTTP ${ingRes.status})`);

            // 3️⃣ Vínculo proveedor principal (el pivot del bug de precios).
            //    Contrato del endpoint (completarFormatoDesdeIngrediente): un caller
            //    que declara `formato` + `precio_formato` "sabe lo que hace" y el
            //    precio canónico €/unidad-base se DERIVA (23,10 / 10 = 2,31).
            //    Mandar `precio` a secas activaría la red de seguridad, que lo
            //    trataría como €/formato — primer aprendizaje de este golden path.
            const linkRes = await request(API_URL)
                .post(`/api/ingredients/${ingredienteId}/suppliers`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    proveedor_id: proveedorId,
                    es_proveedor_principal: true,
                    formato: 'CAJA',
                    cantidad_por_formato: CPF,
                    precio_formato: PRECIO_CAJA
                });
            if (![200, 201].includes(linkRes.status)) {
                throw new Error(`vínculo proveedor falló (HTTP ${linkRes.status})`);
            }

            const ing = await getIngrediente();
            stockInicial = parseFloat(ing?.stock_actual) || 0;
        } catch (e) {
            setupError = e;
        }
    });

    afterAll(async () => {
        if (!authToken) return;
        const del = (path) => request(API_URL)
            .delete(path)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        // Orden inverso al viaje. Las ventas puede haberlas borrado ya el caso 8.
        if (ventaId2) await del(`/api/sales/${ventaId2}`);
        if (recetaId) await del(`/api/recipes/${recetaId}`);
        if (pedidoId) await del(`/api/orders/${pedidoId}`);
        if (ingredienteId) await del(`/api/ingredients/${ingredienteId}`);
        if (proveedorId) await del(`/api/suppliers/${proveedorId}`);
    });

    it('0. El setup montó el viaje entero (si esto falla, nada de lo demás prueba nada)', () => {
        expect(setupError).toBeNull();
        expect(proveedorId).toBeDefined();
        expect(ingredienteId).toBeDefined();
        console.log(`✅ Setup: proveedor ${proveedorId}, ingrediente ${ingredienteId}, stock inicial ${stockInicial}`);
    });

    it('1. El precio del vínculo proveedor quedó en €/unidad-base (2,31), no €/formato (23,10)', async () => {
        const res = await request(API_URL)
            .get(`/api/ingredients/${ingredienteId}/suppliers`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        expect(res.status).toBe(200);
        const filas = res.body?.data || res.body || [];
        const fila = filas.find(f => f.proveedor_id === proveedorId) || filas[0];
        expect(fila).toBeDefined();
        // El bug ARAU guardaba 23,10 €/l (el precio de la CAJA en la columna
        // de €/litro) y el desplegable de pedidos lo re-multiplicaba → 231 €.
        expect(parseFloat(fila.precio)).toBeCloseTo(PRECIO_LITRO, 2);
    });

    it('2. Pedido PENDIENTE programado a +30 días (20 l a 2,31 €/l = 46,20 €) — sin tocar stock', async () => {
        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId,
                fecha: FECHA_PEDIDO,
                estado: 'pendiente',
                total: TOTAL_PEDIDO,
                ingredientes: [{
                    ingredienteId,
                    cantidad: LITROS_PEDIDOS,
                    precioUnitario: PRECIO_LITRO
                }]
            });
        expect([200, 201]).toContain(res.status);
        pedidoId = res.body.id;
        expect(pedidoId).toBeDefined();

        // Regla de la casa: POST /orders NUNCA toca stock.
        const ing = await getIngrediente();
        expect(parseFloat(ing.stock_actual)).toBeCloseTo(stockInicial, 3);
    });

    it('3. Recepción del pedido: la compra diaria existe con el importe correcto', async () => {
        const res = await request(API_URL)
            .put(`/api/orders/${pedidoId}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                estado: 'recibido',
                ingredientes: [{
                    ingredienteId,
                    cantidad: LITROS_PEDIDOS,
                    cantidadRecibida: LITROS_PEDIDOS,
                    precioReal: PRECIO_LITRO,
                    precioUnitario: PRECIO_LITRO
                }],
                total_recibido: TOTAL_PEDIDO
            });
        expect([200, 201]).toContain(res.status);

        // La compra diaria se registra en la fecha de RECEPCIÓN (hoy), no en la
        // del pedido programado: fechaRecepcionFinalReal = body || persistida ||
        // new Date() (orders.routes.js). Se consulta hoy con margen ±1 día para
        // ser inmune al cambio de día UTC↔local en mitad del run.
        let compra = null;
        for (const offset of [0, -1, 1]) {
            const d = new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
            const compras = await request(API_URL)
                .get(`/api/daily/purchases?fecha=${d}`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`);
            if (compras.status !== 200) continue;
            const lista = compras.body?.data || compras.body || [];
            compra = lista.find(c => c.ingrediente_id === ingredienteId);
            if (compra) break;
        }
        expect(compra).toBeDefined();
        // 20 l × 2,31 €/l = 46,20 € — si esto sale 462 € o 4,62 €, el pivot
        // €/formato↔€/unidad-base se ha vuelto a girar en alguna parte.
        // (campos reales del GET: total_compra y precio_unitario, ver daily.routes.js)
        expect(parseFloat(compra.total_compra)).toBeCloseTo(TOTAL_PEDIDO, 2);
        expect(parseFloat(compra.precio_unitario)).toBeCloseTo(PRECIO_LITRO, 2);
    });

    it('3b. El FRONTEND es el dueño del stock: registra la entrada de los 20 l', async () => {
        // Regla de la casa (verificada en orders.routes.js): la recepción por API
        // NO toca stock_actual — el frontend (pedidos-recepcion.js) hace el cálculo
        // y lo aplica vía adjust-stock. Este paso representa ESE rol. Si algún día
        // el backend empezara a sumar stock al recibir, este test lo delataría:
        // el stock acabaría en 40 y el caso 5 fallaría por descuadre.
        const res = await request(API_URL)
            .post(`/api/ingredients/${ingredienteId}/adjust-stock`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({ delta: LITROS_PEDIDOS, reason: 'golden-path: recepción pedido' });
        expect([200, 201]).toContain(res.status);

        const ing = await getIngrediente();
        expect(parseFloat(ing.stock_actual)).toBeCloseTo(stockInicial + LITROS_PEDIDOS, 3);
    });

    it('4. Receta (0,5 l por ración, PVP 10 €) creada', async () => {
        const res = await request(API_URL)
            .post('/api/recipes')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: `PULPO GOLDEN ${sufijo}`,
                categoria: 'test',
                precio_venta: PVP,
                porciones: 1,
                ingredientes: [{ ingredienteId, cantidad: LITROS_POR_RACION }],
                codigo: `GP${String(sufijo).slice(-6)}`
            });
        expect(res.status).toBe(201);
        recetaId = res.body.id;
        expect(recetaId).toBeDefined();
    });

    it('5. Dos ventas: el stock baja exactamente 2 raciones (identidad del inventario)', async () => {
        const stockAntes = parseFloat((await getIngrediente()).stock_actual);

        for (const setVenta of [(id) => { ventaId1 = id; }, (id) => { ventaId2 = id; }]) {
            const res = await request(API_URL)
                .post('/api/sales')
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`)
                .send({ receta_id: recetaId, cantidad: 1, fecha: FECHA });
            expect(res.status).toBe(201);
            setVenta(res.body.id);
        }

        const stockDespues = parseFloat((await getIngrediente()).stock_actual);
        expect(stockAntes - stockDespues).toBeCloseTo(2 * LITROS_POR_RACION, 3);
    });

    it('6. El resumen del día cuadra: ingresos 20 €, PVU realizado 10 €, coste 2,31 €', async () => {
        const fila = await getFilaResumen();
        expect(fila).toBeDefined();

        const unidades = parseFloat(fila.cantidad_vendida);
        const ingresos = parseFloat(fila.total_ingresos);
        const pvu = parseFloat(fila.precio_venta_unitario);
        const coste = parseFloat(fila.coste_ingredientes);
        const beneficio = parseFloat(fila.beneficio_bruto);

        expect(unidades).toBe(2);
        expect(ingresos).toBeCloseTo(2 * PVP, 2);
        // Precio REALIZADO (ingresos/unidades), no el de catálogo — fix cacb8f1.
        expect(pvu).toBeCloseTo(ingresos / unidades, 2);
        // Coste real de 2 raciones: 2 × 0,5 l × 2,31 €/l = 2,31 €. El coste por
        // unidad se redondea a DECIMAL(10,2) (1,155 → 1,16), así que la tolerancia
        // es la de resumen-diario-invariante: unidades × 0,005 + 0,01.
        expect(Math.abs(coste - 2 * COSTE_RACION)).toBeLessThanOrEqual(unidades * 0.005 + 0.011);
        // Invariante contable del P&L. Tolerancia: `coste_ingredientes` y
        // `beneficio_bruto` se redondean POR SEPARADO a DECIMAL(10,2) (con coste
        // por ración de 3 decimales, 1,155 €, el coste redondea a 1,16 y el
        // beneficio se calcula con el valor sin redondear → ±0,01 por unidad).
        expect(Math.abs(beneficio - (ingresos - coste))).toBeLessThanOrEqual(unidades * 0.01 + 0.011);

        // Food cost del día: 2,31 / 20 = 11,55 % — un plato excelente (≤30).
        const foodCost = (coste / ingresos) * 100;
        expect(foodCost).toBeGreaterThan(10);
        expect(foodCost).toBeLessThan(13);
    });

    it('7. Borrar UNA venta deja el coste PROPORCIONAL (no a cero) y devuelve su stock', async () => {
        const stockAntes = parseFloat((await getIngrediente()).stock_actual);

        const del = await request(API_URL)
            .delete(`/api/sales/${ventaId1}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        expect([200, 204]).toContain(del.status);
        ventaId1 = null;

        const fila = await getFilaResumen();
        expect(fila).toBeDefined();
        expect(parseFloat(fila.cantidad_vendida)).toBe(1);
        expect(parseFloat(fila.total_ingresos)).toBeCloseTo(PVP, 2);
        // El bug 8960dee vaciaba esto a 0 por denominador equivocado:
        // debe quedar el coste de UNA ración, 1,155 € (±redondeo DECIMAL(10,2)).
        expect(Math.abs(parseFloat(fila.coste_ingredientes) - COSTE_RACION)).toBeLessThanOrEqual(0.016);
        expect(parseFloat(fila.coste_ingredientes)).toBeGreaterThan(1); // y desde luego NO cero
        expect(parseFloat(fila.beneficio_bruto))
            .toBeCloseTo(parseFloat(fila.total_ingresos) - parseFloat(fila.coste_ingredientes), 2);

        // La venta borrada devuelve su media ración al inventario.
        const stockDespues = parseFloat((await getIngrediente()).stock_actual);
        expect(stockDespues - stockAntes).toBeCloseTo(LITROS_POR_RACION, 3);
    });

    it('8. Borrar la última venta deja el día limpio (sin fila fantasma con dinero)', async () => {
        const del = await request(API_URL)
            .delete(`/api/sales/${ventaId2}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        expect([200, 204]).toContain(del.status);
        ventaId2 = null;

        const fila = await getFilaResumen();
        // Válido: fila eliminada, o fila a cero. Inválido: fila con dinero.
        if (fila) {
            expect(parseFloat(fila.cantidad_vendida)).toBe(0);
            expect(parseFloat(fila.total_ingresos)).toBeCloseTo(0, 2);
        }
    });
});
