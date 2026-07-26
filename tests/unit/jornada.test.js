/**
 * Tests de las reglas de jornada — turno seguido y PARTIDO (2026-07-26).
 *
 * Hasta ahora el modelo sólo admitía un turno por empleado y día
 * (UNIQUE(empleado_id, fecha)), así que el turno partido —la norma en
 * hostelería— era imposible de representar. Estos tests fijan el
 * comportamiento del nuevo modelo de tramos, con los casos que de verdad
 * pasan en un restaurante: cierres pasada la medianoche y descansos cortos.
 */
const {
    DESCANSO_ENTRE_JORNADAS_H,
    duracionTramoHoras,
    horasDeTramos,
    tramosSolapan,
    validarDia,
    comprobarDescansoEntreJornadas,
    tramosDesdePlantilla
} = require('../../src/utils/jornada');

describe('Duración de un tramo (con cruce de medianoche)', () => {
    test.each([
        ['09:00', '17:00', 8],
        ['12:00', '16:00', 4],
        ['20:00', '00:00', 4],     // cierre a medianoche
        ['20:00', '00:30', 4.5],   // cierre pasada la medianoche
        ['22:00', '02:00', 4],     // turno de noche
        ['11:30', '19:30', 8],
        ['10:00', '14:45', 4.75]
    ])('%s → %s = %ph', (inicio, fin, esperado) => {
        expect(duracionTramoHoras(inicio, fin)).toBeCloseTo(esperado, 3);
    });

    test('acepta el HH:MM:SS de Postgres', () => {
        expect(duracionTramoHoras('20:00:00', '00:00:00')).toBeCloseTo(4, 3);
    });

    test('horas inválidas dan null', () => {
        for (const [i, f] of [['abc', '17:00'], ['09:00', '25:00'], [null, '17:00']]) {
            expect(duracionTramoHoras(i, f)).toBeNull();
        }
    });
});

describe('Suma de horas del día', () => {
    test('turno partido clásico: 12-16 + 20-00 = 8h', () => {
        expect(horasDeTramos([
            { hora_inicio: '12:00', hora_fin: '16:00' },
            { hora_inicio: '20:00', hora_fin: '00:00' }
        ])).toBeCloseTo(8, 3);
    });

    test('turno seguido: 09-17 = 8h', () => {
        expect(horasDeTramos([{ hora_inicio: '09:00', hora_fin: '17:00' }])).toBeCloseTo(8, 3);
    });

    test('ignora tramos incompletos en vez de romper', () => {
        expect(horasDeTramos([
            { hora_inicio: '12:00', hora_fin: '16:00' },
            { hora_inicio: '20:00', hora_fin: null }
        ])).toBeCloseTo(4, 3);
    });

    test('sin tramos = 0h', () => {
        expect(horasDeTramos([])).toBe(0);
        expect(horasDeTramos(null)).toBe(0);
    });
});

describe('Solapamiento entre los dos tramos', () => {
    test('partido normal NO solapa', () => {
        expect(tramosSolapan(
            { hora_inicio: '12:00', hora_fin: '16:00' },
            { hora_inicio: '20:00', hora_fin: '00:00' }
        )).toBe(false);
    });

    test('pegados NO solapan (16:00 fin, 16:00 inicio)', () => {
        expect(tramosSolapan(
            { hora_inicio: '12:00', hora_fin: '16:00' },
            { hora_inicio: '16:00', hora_fin: '20:00' }
        )).toBe(false);
    });

    test('pisándose SÍ solapa', () => {
        expect(tramosSolapan(
            { hora_inicio: '12:00', hora_fin: '17:00' },
            { hora_inicio: '16:00', hora_fin: '20:00' }
        )).toBe(true);
    });

    test('un tramo de noche no solapa con uno de mañana del mismo día', () => {
        expect(tramosSolapan(
            { hora_inicio: '22:00', hora_fin: '02:00' },
            { hora_inicio: '09:00', hora_fin: '14:00' }
        )).toBe(false);
    });
});

describe('Validación del día completo', () => {
    test('partido válido pasa y devuelve las horas', () => {
        const r = validarDia([
            { hora_inicio: '12:00', hora_fin: '16:00' },
            { hora_inicio: '20:00', hora_fin: '00:00' }
        ]);
        expect(r.valid).toBe(true);
        expect(r.horas).toBeCloseTo(8, 3);
    });

    test('rechaza más de 2 tramos', () => {
        const r = validarDia([
            { hora_inicio: '09:00', hora_fin: '11:00' },
            { hora_inicio: '13:00', hora_fin: '16:00' },
            { hora_inicio: '20:00', hora_fin: '23:00' }
        ]);
        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/2 tramos/);
    });

    test('rechaza tramos solapados', () => {
        const r = validarDia([
            { hora_inicio: '12:00', hora_fin: '18:00' },
            { hora_inicio: '16:00', hora_fin: '22:00' }
        ]);
        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/solapan/);
    });

    test('rechaza una jornada diaria desmesurada', () => {
        const r = validarDia([
            { hora_inicio: '09:00', hora_fin: '16:00' },
            { hora_inicio: '17:00', hora_fin: '01:00' }
        ]);
        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/12h/);
    });

    test('día vacío es válido (libra)', () => {
        expect(validarDia([]).valid).toBe(true);
        expect(validarDia(null).valid).toBe(true);
    });
});

describe('Descanso legal entre jornadas (12h)', () => {
    test('cerrar a las 00:00 y entrar a las 09:00 NO cumple (9h)', () => {
        const r = comprobarDescansoEntreJornadas(
            [{ hora_inicio: '20:00', hora_fin: '00:00' }],
            [{ hora_inicio: '09:00', hora_fin: '17:00' }]
        );
        expect(r.cumple).toBe(false);
        expect(r.horas).toBeCloseTo(9, 1);
        expect(r.mensaje).toMatch(/12h/);
    });

    test('cerrar a las 00:00 y entrar a las 12:00 SÍ cumple (12h justas)', () => {
        const r = comprobarDescansoEntreJornadas(
            [{ hora_inicio: '20:00', hora_fin: '00:00' }],
            [{ hora_inicio: '12:00', hora_fin: '16:00' }]
        );
        expect(r.cumple).toBe(true);
        expect(r.horas).toBeCloseTo(12, 1);
    });

    test('mide desde el FIN del último tramo del partido, no del primero', () => {
        const r = comprobarDescansoEntreJornadas(
            [
                { hora_inicio: '12:00', hora_fin: '16:00' },
                { hora_inicio: '20:00', hora_fin: '00:30' }   // cierra a las 00:30
            ],
            [{ hora_inicio: '12:00', hora_fin: '16:00' }]
        );
        expect(r.cumple).toBe(false);
        expect(r.horas).toBeCloseTo(11.5, 1);
    });

    test('mide hasta el INICIO más temprano del día siguiente', () => {
        const r = comprobarDescansoEntreJornadas(
            [{ hora_inicio: '16:00', hora_fin: '23:00' }],
            [
                { hora_inicio: '20:00', hora_fin: '00:00' },
                { hora_inicio: '10:00', hora_fin: '14:00' }   // este es el que cuenta
            ]
        );
        expect(r.cumple).toBe(false);
        expect(r.horas).toBeCloseTo(11, 1);
    });

    test('si algún día libra, no hay nada que comprobar', () => {
        expect(comprobarDescansoEntreJornadas([], [{ hora_inicio: '09:00', hora_fin: '17:00' }]).cumple).toBe(true);
        expect(comprobarDescansoEntreJornadas([{ hora_inicio: '09:00', hora_fin: '17:00' }], []).cumple).toBe(true);
    });

    test('el mínimo legal es 12h', () => {
        expect(DESCANSO_ENTRE_JORNADAS_H).toBe(12);
    });
});

describe('Tramos generados desde la plantilla de la ficha', () => {
    test('seguido sin hora de fin: reparte el contrato', () => {
        const t = tramosDesdePlantilla({ jornada_tipo: 'seguido', tramo1_inicio: '10:00' }, 480);
        expect(t).toEqual([{ tramo: 1, hora_inicio: '10:00', hora_fin: '18:00' }]);
    });

    test('seguido con hora de fin en la ficha: manda la ficha', () => {
        const t = tramosDesdePlantilla(
            { jornada_tipo: 'seguido', tramo1_inicio: '11:30', tramo1_fin: '19:30' }, 480);
        expect(t).toEqual([{ tramo: 1, hora_inicio: '11:30', hora_fin: '19:30' }]);
    });

    test('partido con horas definidas: las respeta tal cual', () => {
        const t = tramosDesdePlantilla({
            jornada_tipo: 'partido',
            tramo1_inicio: '12:00', tramo1_fin: '16:00',
            tramo2_inicio: '20:00', tramo2_fin: '00:00'
        }, 480);
        expect(t).toEqual([
            { tramo: 1, hora_inicio: '12:00', hora_fin: '16:00' },
            { tramo: 2, hora_inicio: '20:00', hora_fin: '00:00' }
        ]);
        expect(horasDeTramos(t)).toBeCloseTo(8, 3);
    });

    test('partido sin horas de fin: reparte la jornada mitad y mitad', () => {
        const t = tramosDesdePlantilla({
            jornada_tipo: 'partido', tramo1_inicio: '12:00', tramo2_inicio: '20:00'
        }, 480);
        expect(t[0]).toEqual({ tramo: 1, hora_inicio: '12:00', hora_fin: '16:00' });
        expect(t[1]).toEqual({ tramo: 2, hora_inicio: '20:00', hora_fin: '00:00' });
        expect(horasDeTramos(t)).toBeCloseTo(8, 3);
    });

    test('reparto impar: no pierde minutos', () => {
        const t = tramosDesdePlantilla({
            jornada_tipo: 'partido', tramo1_inicio: '12:00', tramo2_inicio: '20:00'
        }, 285); // 4h45
        expect(horasDeTramos(t) * 60).toBeCloseTo(285, 0);
    });

    test('ficha vacía cae a jornada seguida desde las 10:00', () => {
        const t = tramosDesdePlantilla({}, 480);
        expect(t).toEqual([{ tramo: 1, hora_inicio: '10:00', hora_fin: '18:00' }]);
    });

    test('los tramos generados por la plantilla siempre son un día válido', () => {
        for (const minutos of [240, 300, 480, 600]) {
            const t = tramosDesdePlantilla({
                jornada_tipo: 'partido', tramo1_inicio: '12:00', tramo2_inicio: '20:00'
            }, minutos);
            expect(validarDia(t).valid).toBe(true);
        }
    });
});
