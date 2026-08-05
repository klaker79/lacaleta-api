/**
 * ═══════════════════════════════════════════════════════════════════
 * 🛡️ Informe mensual — el food cost divide por la MISMA fuente
 * ═══════════════════════════════════════════════════════════════════
 * El numerador (`cogsActual`) sale de `ventas_diarias_resumen`.
 * El denominador salía de `ventas.total` — OTRA TABLA.
 *
 * Si hay ventas sin fila en el resumen (receta borrada, venta sin receta,
 * importaciones antiguas), el denominador crece sin que crezca el numerador
 * y el porcentaje se hunde.
 *
 * Medido en La Nave 5 (rid=3): 1.500 ventas huérfanas por 65.830 €, todas de
 * enero–marzo 2026. El informe daba:
 *     enero    15,2 %   cuando el real era 32,0 %   ← 16,8 puntos
 *     marzo    28,3 %   cuando el real era 36,0 %   ←  7,7 puntos
 *     febrero  0 filas de coste → habría salido 0 %
 * De abril en adelante no hay huérfanas y ambos cálculos coinciden.
 *
 * Un food cost del 15 % en un restaurante no existe: es una cifra imposible
 * que se enseñaba en el PDF que el dueño lleva a socios.
 *
 * Es el MISMO bug que ya se arregló en `chatService.js` (comentario de
 * `fc_total`, detectado 2026-07-08). Allí se corrigió; aquí no. Este test
 * existe para que no se vuelva a separar.
 */

const fs = require('fs');
const path = require('path');

const RUTA = path.join(__dirname, '..', '..', 'src', 'services', 'informeMensualService.js');
const src = fs.readFileSync(RUTA, 'utf8');

describe('🛡️ informeMensualService — food cost con denominador coherente', () => {
    it('getCogsMes devuelve TAMBIÉN los ingresos de su misma fuente', () => {
        const fn = src.match(/async function getCogsMes[\s\S]*?\n\}/);
        expect(fn).not.toBeNull();
        // Debe seleccionar los dos campos de ventas_diarias_resumen.
        expect(fn[0]).toMatch(/SUM\(coste_ingredientes\)/);
        expect(fn[0]).toMatch(/SUM\(total_ingresos\)/);
        expect(fn[0]).toMatch(/ingresosConCoste/);
    });

    it('el food cost NO divide por ingresos.mes_actual (otra tabla)', () => {
        const bloque = src.match(/const\s+foodCostPct\s*=[\s\S]{0,300}?;\r?\n/);
        expect(bloque).not.toBeNull();
        // ⛔ Este era el bug exacto.
        expect(bloque[0]).not.toMatch(/cogsActual\s*\/\s*ingresos\.mes_actual/);
        expect(bloque[0]).toMatch(/ingresosFoodCost/);
    });

    it('el food cost REAL (con mermas) usa el mismo denominador', () => {
        const bloque = src.match(/const\s+foodCostRealPct\s*=[\s\S]{0,300}?;\r?\n/);
        expect(bloque).not.toBeNull();
        expect(bloque[0]).not.toMatch(/ingresos\.mes_actual/);
        expect(bloque[0]).toMatch(/ingresosFoodCost/);
    });

    it('hay fallback si el resumen está vacío, para no devolver 0 con ventas', () => {
        const bloque = src.match(/const\s+ingresosFoodCost\s*=[\s\S]{0,300}?;\r?\n/);
        expect(bloque).not.toBeNull();
        expect(bloque[0]).toMatch(/ingresos\.mes_actual/);
    });

    it('el P&L (margen bruto) SÍ sigue usando el ingreso real de caja', () => {
        // El food cost cambia de denominador, pero el margen bruto del P&L debe
        // seguir restando el COGS del dinero REALMENTE ingresado. Son cosas
        // distintas y no hay que confundirlas al arreglar esto.
        expect(src).toMatch(/const\s+margenBruto\s*=\s*ingresos\.mes_actual\s*-\s*cogsActual/);
    });

    it('la aritmética del arreglo reproduce los números reales de La Nave 5', () => {
        // Enero 2026 (cifras medidas en producción).
        const cogs = 1780.5;            // de ventas_diarias_resumen
        const ingresosResumen = 5563.0; // de la misma fuente
        const ingresosVentas = 11687.7; // de la tabla ventas (incluye huérfanas)

        const antes = Math.round((cogs / ingresosVentas) * 10000) / 100;
        const ahora = Math.round((cogs / ingresosResumen) * 10000) / 100;

        expect(antes).toBeLessThan(20);        // ~15,2 % — imposible en hostelería
        expect(ahora).toBeGreaterThan(30);     // ~32,0 % — creíble
        expect(ahora - antes).toBeGreaterThan(15);
    });
});
