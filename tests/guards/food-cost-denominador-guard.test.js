/**
 * GUARD — el food cost total de Omnes (chatService `resumen_pyg`) debe dividir
 * el COGS entre la MISMA base de ingresos (comida + bebida de
 * ventas_diarias_resumen), NO entre `ingresos` (SUM(total) de la tabla
 * `ventas`, que incluye ventas de 'otros'/recetas borradas/sin receta cuyo
 * coste NO está en el numerador).
 *
 * Bug real 2026-07-08: `fc_total = cogs_periodo / ingresos` daba a La Nave 5 un
 * food cost del 29% (COGS de 352k dividido entre 415k) cuando el real es 34,2%
 * (comida 33,5% + bebida 37%). Este guard falla si se reintroduce ese patrón.
 */
const fs = require('fs');
const path = require('path');

const CHAT_SERVICE = path.join(__dirname, '..', '..', 'src', 'services', 'chatService.js');

function sinComentarios(texto) {
    return texto
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
}

describe('GUARD — food cost de Omnes usa la base correcta (comida + bebida)', () => {
    const code = sinComentarios(fs.readFileSync(CHAT_SERVICE, 'utf8'));

    it('fc_total divide COGS entre ing_food + ing_beverage (misma fuente)', () => {
        expect(code).toMatch(/ingresos_food_bev\s*=\s*ing_food\s*\+\s*ing_beverage/);
        expect(code).toMatch(/cogs_periodo\s*\/\s*ingresos_food_bev/);
    });

    it('NO reintroduce el patrón buggy `cogs_periodo / ingresos`', () => {
        // \b tras "ingresos" NO casa con "ingresos_food_bev" (el _ es word char),
        // así que esto solo detecta el denominador equivocado.
        expect(code).not.toMatch(/cogs_periodo\s*\/\s*ingresos\b/);
    });
});
