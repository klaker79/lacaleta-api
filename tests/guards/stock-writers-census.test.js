/**
 * ═══════════════════════════════════════════════════════════════════
 * 🛡️ CENSO DE ESCRITORES DE STOCK — guardián de la Fase D
 * ═══════════════════════════════════════════════════════════════════
 *
 * `ingredientes.stock_actual` es EL número del inventario: cada sitio que lo
 * escribe es una puerta por la que el stock puede descuadrarse (el clamp del
 * tanque perdió 488 l = 1.191 € justo por una puerta que nadie vigilaba).
 *
 * La auditoría 2026-08-03 encontró 13 escritores; la Fase D eliminó 3 (capa
 * DDD huérfana) y CONGELA los 10 que quedan. Este guardián:
 *
 *   1. FALLA si un archivo NUEVO escribe stock_actual → usa una puerta
 *      existente (adjust-stock / bulk de ingredients.routes es la genérica)
 *      o justifica la nueva puerta en el PR y añádela aquí CON su porqué.
 *   2. FALLA si una puerta censada DEJA de escribir → así el censo nunca
 *      miente (una lista con muertos da la misma falsa confianza que un
 *      guardián que valida el archivo equivocado — incidente CORS).
 *
 * Las 9 puertas de LITE y su porqué (verificadas 2026-08-04; main tiene 10 — añade consumos-internos, feature que lite no monta):
 *   - routes/sales.routes.js        venta descuenta / borrar venta devuelve (con lock por id)
 *   - routes/orders.routes.js       borrar pedido RECIBIDO revierte su stock (solo delete)
 *   - routes/ingredients.routes.js  adjust-stock y bulk-adjust-stock (la puerta del frontend, dueño del stock)
 *   - routes/inventory.routes.js    recuento físico (stock-real / bulk-update / consolidate)
 *   - routes/mermas.routes.js       merma descuenta
 * *   - routes/transfers.routes.js    traspaso entre restaurantes (resta origen / suma destino)
 *   - routes/balance.routes.js      compras pendientes aprobadas suman stock
 *   - services/SaleService.js       import masivo de ventas (bulk) descuenta
 *   - services/IngredientService.js gestión directa de ingrediente
 *
 * Probado por MUTACIÓN (regla 5 del CLAUDE.md) al crearlo: un archivo nuevo
 * con `UPDATE ingredientes SET stock_actual` puso este test en rojo.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');

// Un "escritor" es un archivo con un UPDATE a ingredientes que asigna
// stock_actual (hasta 400 chars entre el UPDATE y la asignación cubre los
// SET multicolumna del código real).
const WRITER_RE = /UPDATE\s+ingredientes\b[\s\S]{0,400}?\bstock_actual\s*=/i;

const PUERTAS_CENSADAS = [
    'routes/balance.routes.js',
    'routes/ingredients.routes.js',
    'routes/inventory.routes.js',
    'routes/mermas.routes.js',
    'routes/orders.routes.js',
    'routes/sales.routes.js',
    'routes/transfers.routes.js',
    'services/IngredientService.js',
    'services/SaleService.js',
];

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
        return e.name.endsWith('.js') ? [p] : [];
    });
}

function escritoresActuales() {
    return walk(SRC)
        .filter((f) => WRITER_RE.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
        .sort();
}

describe('🛡️ Censo de escritores de stock_actual (Fase D)', () => {
    const actuales = escritoresActuales();

    it('ninguna puerta NUEVA escribe stock fuera del censo', () => {
        const nuevas = actuales.filter((f) => !PUERTAS_CENSADAS.includes(f));
        if (nuevas.length) {
            throw new Error(
                `Archivo(s) NUEVO(S) escribiendo ingredientes.stock_actual: ${nuevas.join(', ')}.\n` +
                'El stock se descuadra por puertas sin vigilar. Usa una puerta existente ' +
                '(adjust-stock/bulk-adjust-stock de ingredients.routes es la genérica) o, si la ' +
                'puerta nueva está justificada, añádela al censo de este guardián CON su porqué.'
            );
        }
        expect(nuevas).toEqual([]);
    });

    it('ninguna puerta censada ha dejado de escribir (el censo no miente)', () => {
        const zombis = PUERTAS_CENSADAS.filter((f) => !actuales.includes(f));
        if (zombis.length) {
            throw new Error(
                `Puerta(s) censada(s) que YA NO escriben stock: ${zombis.join(', ')}.\n` +
                'Bórralas del censo — una lista con muertos da falsa confianza (regla 5, incidente CORS).'
            );
        }
        expect(zombis).toEqual([]);
    });

    it(`el censo tiene exactamente ${PUERTAS_CENSADAS.length} puertas`, () => {
        expect(actuales).toEqual([...PUERTAS_CENSADAS].sort());
    });
});
