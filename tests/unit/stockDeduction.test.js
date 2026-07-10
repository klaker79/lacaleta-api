const { agregarDeduccionesOrdenadas, esDeadlock } = require('../../src/utils/stockDeduction');

describe('stockDeduction — agregarDeduccionesOrdenadas (anti-deadlock)', () => {
    it('ordena por id ascendente (orden de lock determinista) sea cual sea el orden de receta', () => {
        // Orden de receta caótico como el del incidente: 1116, 1117, 1113
        const baseIngs = [
            { ingredienteId: 1116, cantidadPorPorcion: 0.125 },
            { ingredienteId: 1117, cantidadPorPorcion: 0.0625 },
            { ingredienteId: 1113, cantidadPorPorcion: 0.125 },
        ];
        const out = agregarDeduccionesOrdenadas(baseIngs, 5);
        expect(out.map(d => d.ingredienteId)).toEqual([1113, 1116, 1117]);
        // cantidad = cantidadPorPorcion × multiplicador
        expect(out.find(d => d.ingredienteId === 1113).cantidad).toBeCloseTo(0.625, 6);
    });

    it('AGREGA duplicados (mismo ingrediente base de varias subrecetas) en una sola entrada', () => {
        const baseIngs = [
            { ingredienteId: 50, cantidadPorPorcion: 0.1 },
            { ingredienteId: 50, cantidadPorPorcion: 0.2 },
            { ingredienteId: 10, cantidadPorPorcion: 1 },
        ];
        const out = agregarDeduccionesOrdenadas(baseIngs, 2);
        expect(out).toEqual([
            { ingredienteId: 10, cantidad: 2 },
            { ingredienteId: 50, cantidad: 0.6000000000000001 }, // (0.1+0.2)×2, tolerado por el consumidor
        ]);
    });

    it('filtra ids vacíos y cantidades no positivas', () => {
        const baseIngs = [
            { ingredienteId: null, cantidadPorPorcion: 5 },
            { ingredienteId: 7, cantidadPorPorcion: 0 },
            { ingredienteId: 8, cantidadPorPorcion: -1 },
            { ingredienteId: 9, cantidadPorPorcion: 0.5 },
        ];
        expect(agregarDeduccionesOrdenadas(baseIngs, 3)).toEqual([{ ingredienteId: 9, cantidad: 1.5 }]);
    });

    it('devuelve [] con multiplicador 0/NaN o baseIngs no-array', () => {
        expect(agregarDeduccionesOrdenadas([{ ingredienteId: 1, cantidadPorPorcion: 1 }], 0)).toEqual([]);
        expect(agregarDeduccionesOrdenadas([{ ingredienteId: 1, cantidadPorPorcion: 1 }], NaN)).toEqual([]);
        expect(agregarDeduccionesOrdenadas(null, 5)).toEqual([]);
    });

    it('dos "ventas" con recetas distintas que comparten ingredientes producen el MISMO orden de lock', () => {
        const ventaA = agregarDeduccionesOrdenadas([
            { ingredienteId: 1116, cantidadPorPorcion: 1 },
            { ingredienteId: 1113, cantidadPorPorcion: 1 },
        ], 1).map(d => d.ingredienteId);
        const ventaB = agregarDeduccionesOrdenadas([
            { ingredienteId: 1113, cantidadPorPorcion: 1 },
            { ingredienteId: 1116, cantidadPorPorcion: 1 },
        ], 1).map(d => d.ingredienteId);
        // Ambas bloquean en el mismo orden → imposible el ciclo de espera
        expect(ventaA).toEqual(ventaB);
        expect(ventaA).toEqual([1113, 1116]);
    });
});

describe('stockDeduction — esDeadlock', () => {
    it('detecta deadlock (40P01) y serialization_failure (40001)', () => {
        expect(esDeadlock({ code: '40P01' })).toBe(true);
        expect(esDeadlock({ code: '40001' })).toBe(true);
    });
    it('no marca otros errores', () => {
        expect(esDeadlock({ code: '23505' })).toBe(false);
        expect(esDeadlock(new Error('x'))).toBe(false);
        expect(esDeadlock(null)).toBe(false);
    });
});
