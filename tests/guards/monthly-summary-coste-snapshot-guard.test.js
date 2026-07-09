/**
 * GUARD — /monthly/summary debe usar el SNAPSHOT de ventas_diarias_resumen como
 * fuente PRINCIPAL del coste (el coste del día que se vendió), y el cálculo en
 * vivo (calcularCosteReceta, precios de hoy) SOLO como fallback sin snapshot.
 *
 * Decisión contable de Iker (auditoría 2026-07-09): el P&L cuenta el coste del
 * día de la venta. Antes las recetas vivas se recalculaban con los precios
 * medios ACTUALES → la tabla "Cuenta de Resultados" divergía de la tarjeta KPI
 * (pnl-breakdown) en 8,64€ y la cifra se movía sola al recibir compras.
 *
 * Si este guard falla es que alguien ha vuelto a poner el cálculo vivo por
 * delante del snapshot. NO lo hagas sin hablar con Iker: rompe el cuadre
 * tarjeta↔tabla del Diario.
 */
const fs = require('fs');
const path = require('path');

describe('guard: coste de /monthly/summary = snapshot vdr (no precios de hoy)', () => {
    const src = fs.readFileSync(
        path.resolve(__dirname, '../../src/routes/monthly.routes.js'),
        'utf8'
    );

    test('el bloque de ventas consulta el snapshot ANTES de decidir el coste', () => {
        // Dentro del forEach de ventasDiarias: primero snapshotMap.get, y el
        // cálculo vivo solo dentro de una rama posterior (fallback).
        const bloque = src.split('ventasDiarias.rows.forEach')[1] || '';
        const posSnap = bloque.indexOf('snapshotMap.get');
        const posVivo = bloque.indexOf('calcularCosteReceta(');
        expect(posSnap).toBeGreaterThan(-1);
        expect(posVivo).toBeGreaterThan(-1);
        expect(posSnap).toBeLessThan(posVivo);
    });

    test('el snapshot manda: `if (snap)` asigna el coste del snapshot', () => {
        expect(src).toMatch(/if \(snap\) \{\s*\n\s*costeTotal = snap\.costeTotal;/);
    });

    test('el comentario de la decisión contable sigue presente (no borrar sin hablar con Iker)', () => {
        expect(src).toContain('COSTE CANÓNICO = SNAPSHOT');
    });
});
