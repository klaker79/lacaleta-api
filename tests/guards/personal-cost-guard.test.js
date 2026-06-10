/**
 * GUARD — el gasto de COMIDA PERSONAL nunca debe colarse en agregados de compras.
 *
 * `pedidos.total` incluye las líneas marcadas `personal: true` (la app las suma al
 * total para cuadrar con el albarán). Pero esas líneas NO son gasto del restaurante
 * (van a su pestaña). Por eso, CUALQUIER query que sume el total de pedidos para
 * calcular gasto/compras/cash-flow/P&L DEBE restar su coste con `personalCostExpr()`
 * de src/utils/personalCost.js  →  `SUM(p.total - ${personalCostExpr('p')})`.
 *
 * Incidente 2026-06-10: hubo que parchear 8 sitios. Este test (estático, sin servidor)
 * impide que un agregado NUEVO vuelva a sumar pedidos.total en crudo y filtre el gasto
 * del personal a "la cuenta del restaurante".
 *
 * Si este test falla: usa personalCostExpr en tu SUM, o —si de verdad es una excepción
 * legítima— justifícalo y añade el archivo a EXENTOS con un comentario.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');

// El helper define la propia resta; no se escanea a sí mismo.
const EXENTOS = new Set([
    path.join(SRC, 'utils', 'personalCost.js'),
]);

function listarJs(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listarJs(full));
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

describe('GUARD comida personal — ningún SUM(pedidos.total) sin restar lo personal', () => {
    it('todo SUM del total de pedidos resta el coste personal (personalCostExpr)', () => {
        const archivos = listarJs(SRC).filter(f => !EXENTOS.has(f));
        const infracciones = [];

        for (const file of archivos) {
            const texto = fs.readFileSync(file, 'utf8');
            // Todas las expresiones SUM(...) que mencionan la palabra "total".
            // (\btotal\b excluye total_compra, total_recibido, etc.)
            const regex = /SUM\s*\(([^)]*\btotal\b[^)]*)\)/gi;
            let m;
            while ((m = regex.exec(texto)) !== null) {
                const expr = m[0];
                const idx = m.index;

                // ¿Suma el total de PEDIDOS?
                let esPedido = /\bp\.total\b|\bpedidos\.total\b/.test(expr);
                if (!esPedido && /\(\s*total\s*\)/.test(expr)) {
                    // SUM(total) a secas: ambiguo (ventas vs pedidos). Mirar el FROM
                    // cercano: pedidos sí, y que no sea una query de ventas.
                    const ventana = texto.slice(idx, idx + 250);
                    if (/FROM\s+pedidos\b/i.test(ventana) && !/FROM\s+ventas\b/i.test(ventana)) {
                        esPedido = true;
                    }
                }
                if (!esPedido) continue;

                // Debe restar lo personal (usar personalCostExpr).
                const restaPersonal = /personalCostExpr|personal/i.test(expr);
                if (!restaPersonal) {
                    const linea = texto.slice(0, idx).split('\n').length;
                    infracciones.push(`${path.relative(SRC, file).replace(/\\/g, '/')}:${linea}  →  ${expr.trim()}`);
                }
            }
        }

        if (infracciones.length > 0) {
            throw new Error(
                'SUM de pedidos.total SIN restar comida personal.\n' +
                'Usa `SUM(p.total - ${personalCostExpr(\'p\')})` (src/utils/personalCost.js):\n  ' +
                infracciones.join('\n  ')
            );
        }
        expect(infracciones).toHaveLength(0);
    });
});
