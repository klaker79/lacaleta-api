/**
 * rangosDashboard — los rangos de fecha que el chat inyecta al modelo DEBEN ser
 * idénticos a los del toggle del dashboard (rangoPeriodo, FE _shared.js). Si no,
 * Omnes da un food cost "de esta semana" que no cuadra con lo que ve el cliente.
 * Nació del fallo 17-jun: el modelo calculaba el lunes a ojo (usó 9-17 jun en vez
 * de la semana natural 15-22) → ahora se los damos hechos y él solo los copia.
 */
const { rangosDashboard } = require('../../src/services/chatService');

describe('rangosDashboard — mismos rangos que el toggle del dashboard', () => {
    test('miércoles 17-jun-2026 → semana natural lunes 15 a 22 (exclusive)', () => {
        const r = rangosDashboard(new Date(2026, 5, 17)); // mes 5 = junio (local)
        expect(r.semana).toEqual({ desde: '2026-06-15', hasta: '2026-06-22' });
    });

    test('mes natural en curso = día 1 al 1º del mes siguiente (exclusive)', () => {
        const r = rangosDashboard(new Date(2026, 5, 17));
        expect(r.mes).toEqual({ desde: '2026-06-01', hasta: '2026-07-01' });
    });

    test('hoy = today al día siguiente (exclusive)', () => {
        const r = rangosDashboard(new Date(2026, 5, 17));
        expect(r.hoy).toEqual({ desde: '2026-06-17', hasta: '2026-06-18' });
    });

    test('lunes → la semana empieza ese mismo lunes', () => {
        const r = rangosDashboard(new Date(2026, 5, 15)); // lunes 15
        expect(r.semana.desde).toBe('2026-06-15');
        expect(r.semana.hasta).toBe('2026-06-22');
    });

    test('domingo → pertenece a la semana que empezó el lunes anterior', () => {
        const r = rangosDashboard(new Date(2026, 5, 21)); // domingo 21
        expect(r.semana).toEqual({ desde: '2026-06-15', hasta: '2026-06-22' });
    });

    test('cruce de mes: 1-jul-2026 (miércoles) → semana cruza junio/julio', () => {
        const r = rangosDashboard(new Date(2026, 6, 1)); // miércoles 1 jul
        expect(r.semana).toEqual({ desde: '2026-06-29', hasta: '2026-07-06' });
        expect(r.mes).toEqual({ desde: '2026-07-01', hasta: '2026-08-01' });
    });

    // Ventanas móviles "últimos N días" — INCLUYEN hoy y son DETERMINISTAS.
    // Nació del fallo 19-jun: misma pregunta ("últimos 3 días") el mismo día en
    // dos ordenadores daba 16-18 en uno y 17-19 en otro (el modelo elegía la
    // ventana a ojo). Ahora se calcula aquí: hoy=19 → SIEMPRE 17 a 20 (exclusive).
    test('últimos 3 días incluye hoy: hoy 19-jun → 17 a 20 (exclusive)', () => {
        const r = rangosDashboard(new Date(2026, 5, 19));
        expect(r.ultimos3).toEqual({ desde: '2026-06-17', hasta: '2026-06-20' });
    });

    test('últimos 7 días incluye hoy: hoy 19-jun → 13 a 20', () => {
        const r = rangosDashboard(new Date(2026, 5, 19));
        expect(r.ultimos7).toEqual({ desde: '2026-06-13', hasta: '2026-06-20' });
    });

    test('últimos 30 días incluye hoy: hoy 19-jun → 21-may a 20-jun', () => {
        const r = rangosDashboard(new Date(2026, 5, 19));
        expect(r.ultimos30).toEqual({ desde: '2026-05-21', hasta: '2026-06-20' });
    });

    test('mismo día → misma ventana SIEMPRE (determinista)', () => {
        const a = rangosDashboard(new Date(2026, 5, 19));
        const b = rangosDashboard(new Date(2026, 5, 19));
        expect(a.ultimos3).toEqual(b.ultimos3);
    });
});
