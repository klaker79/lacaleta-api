/**
 * tests/unit/chatAnalisisTools.test.js
 *
 * Garantiza que las tools `analisis_menu_engineering` y `analisis_omnes`
 * del chat IA delegan en `menuEngineeringService` con los args correctos.
 *
 * Este es el blindaje crítico de coherencia chat↔app: si alguien refactoriza
 * el servicio (cambia signature, añade un campo, etc.) sin actualizar las
 * tools, el chat empieza a darle datos divergentes al modelo y el cliente
 * recibe respuestas que no coinciden con lo que ve en la pestaña Análisis.
 *
 * Mockeamos el servicio para SPY las llamadas — no necesitamos DB ni API.
 */

jest.mock('../../src/services/menuEngineeringService', () => ({
    getMenuEngineering: jest.fn(),
    getOmnesAnalysis: jest.fn(),
    resolverPeriodo: jest.requireActual('../../src/services/menuEngineeringService').resolverPeriodo
}));

const service = require('../../src/services/menuEngineeringService');
const { runTool, TOOLS } = require('../../src/services/chatService');

const fakePool = { query: jest.fn() };

beforeEach(() => {
    service.getMenuEngineering.mockReset();
    service.getOmnesAnalysis.mockReset();
});

describe('Chat tools — definiciones expuestas', () => {
    test('TOOLS incluye analisis_menu_engineering y analisis_omnes', () => {
        const names = TOOLS.map(t => t.name);
        expect(names).toContain('analisis_menu_engineering');
        expect(names).toContain('analisis_omnes');
    });

    test('analisis_menu_engineering acepta desde/hasta opcionales', () => {
        const tool = TOOLS.find(t => t.name === 'analisis_menu_engineering');
        expect(tool.input_schema.properties).toHaveProperty('desde');
        expect(tool.input_schema.properties).toHaveProperty('hasta');
        expect(tool.input_schema.required).toEqual([]);
    });

    test('analisis_omnes acepta desde/hasta opcionales', () => {
        const tool = TOOLS.find(t => t.name === 'analisis_omnes');
        expect(tool.input_schema.properties).toHaveProperty('desde');
        expect(tool.input_schema.properties).toHaveProperty('hasta');
        expect(tool.input_schema.required).toEqual([]);
    });
});

describe('Chat tools — runTool delega en menuEngineeringService', () => {
    test('analisis_menu_engineering llama getMenuEngineering con restauranteId + periodo', async () => {
        service.getMenuEngineering.mockResolvedValue([{ id: 1, nombre: 'X' }]);
        const result = await runTool('analisis_menu_engineering', fakePool, 7, {
            desde: '2026-01-01',
            hasta: '2026-02-01'
        });
        expect(service.getMenuEngineering).toHaveBeenCalledTimes(1);
        const [poolArg, ridArg, optsArg] = service.getMenuEngineering.mock.calls[0];
        expect(poolArg).toBe(fakePool);
        expect(ridArg).toBe(7);
        expect(optsArg).toEqual({ desde: '2026-01-01', hasta: '2026-02-01' });
        expect(result).toEqual([{ id: 1, nombre: 'X' }]);
    });

    test('analisis_menu_engineering sin periodo pasa undefined al servicio', async () => {
        service.getMenuEngineering.mockResolvedValue([]);
        await runTool('analisis_menu_engineering', fakePool, 3, {});
        const [, , optsArg] = service.getMenuEngineering.mock.calls[0];
        expect(optsArg).toEqual({ desde: undefined, hasta: undefined });
    });

    test('analisis_menu_engineering rechaza fechas con formato inválido', async () => {
        service.getMenuEngineering.mockResolvedValue([]);
        await expect(
            runTool('analisis_menu_engineering', fakePool, 1, { desde: 'no-fecha' })
        ).rejects.toThrow(/YYYY-MM-DD/);
    });

    test('analisis_omnes llama getOmnesAnalysis con restauranteId + periodo', async () => {
        const fakeResponse = {
            periodo: { desde: '2026-03-01', hasta: '2026-04-01' },
            dispersion: { valor: 2.0, estado: 'ok' },
            amplitud: { baja_pct: 25, media_pct: 50, alta_pct: 25, estado: 'equilibrada' },
            calidad_precio: { ratio: 1.0, estado: 'equilibrado' },
            recomendacion_global: 'Bien.'
        };
        service.getOmnesAnalysis.mockResolvedValue(fakeResponse);
        const result = await runTool('analisis_omnes', fakePool, 9, {
            desde: '2026-03-01',
            hasta: '2026-04-01'
        });
        expect(service.getOmnesAnalysis).toHaveBeenCalledTimes(1);
        const [poolArg, ridArg, optsArg] = service.getOmnesAnalysis.mock.calls[0];
        expect(poolArg).toBe(fakePool);
        expect(ridArg).toBe(9);
        expect(optsArg).toEqual({ desde: '2026-03-01', hasta: '2026-04-01' });
        // Coherencia: la salida del runTool es IDÉNTICA a la del servicio
        expect(result).toBe(fakeResponse);
    });

    test('analisis_omnes sin periodo pasa undefined al servicio', async () => {
        service.getOmnesAnalysis.mockResolvedValue({});
        await runTool('analisis_omnes', fakePool, 4, {});
        const [, , optsArg] = service.getOmnesAnalysis.mock.calls[0];
        expect(optsArg).toEqual({ desde: undefined, hasta: undefined });
    });

    test('analisis_omnes rechaza fechas con formato inválido', async () => {
        service.getOmnesAnalysis.mockResolvedValue({});
        await expect(
            runTool('analisis_omnes', fakePool, 1, { hasta: '01-01-2026' })
        ).rejects.toThrow(/YYYY-MM-DD/);
    });
});
