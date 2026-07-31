/**
 * 🛡️ GUARDIA — cada herramienta del chat ejecuta SQL VÁLIDO contra el esquema real.
 *
 * Ejecuta TODAS las tools de `chatService.TOOLS` contra la BD de test (el CI
 * arranca `server.js`, que corre init.js y crea el esquema en `lacaleta_ci`).
 * FALLA si alguna query referencia una columna/tabla inexistente o tiene SQL
 * inválido.
 *
 * Bug class que previene: `obtener_horarios` usaba `h.dia_semana`, columna que
 * NO existe en `horarios` (es por fecha/turno) → `column h.dia_semana does not
 * exist` en PRODUCCIÓN (Sentry 2026-07-31). Los tests unitarios del chat usan
 * un pool MOCKEADO, así que no ejecutan el SQL real y no lo cazaron. Este guard
 * usa el pool REAL y lo habría detectado en CI antes del deploy.
 *
 * NO valida el contenido (la BD de CI puede no tener datos de este tenant): un
 * error de esquema/sintaxis SQL se dispara igual contra tablas vacías. Otros
 * errores (argumento faltante, dato no encontrado…) se toleran a propósito —
 * este guard SOLO vela por que el SQL sea válido contra el esquema.
 */

const { runTool, TOOLS } = require('../../src/services/chatService');
const { pool } = require('../../src/config/database');

// Un restaurante_id cualquiera: un error de columna/tabla salta con o sin datos.
const RID = 1;

// Args genéricos que satisfacen a las tools que exigen periodo/fechas/nombre.
const ARGS = {
    periodo: 'mes',
    fecha_desde: '2026-01-01',
    fecha_hasta: '2026-02-01',
    nombre_o_id: 'guard-test',
    dias: 30,
    dias_servicio: 30
};

// Errores de ESQUEMA / SQL que este guard NO tolera (los que debe cazar):
const SCHEMA_ERROR = /does not exist|column .* does not exist|relation .* does not exist|syntax error|operator does not exist|no existe la (columna|relación|función)/i;

afterAll(async () => {
    await pool.end();
});

describe('🛡️ Herramientas del chat — SQL válido contra el esquema', () => {
    const nombres = TOOLS.map(t => t.name);

    it('hay herramientas registradas que probar', () => {
        expect(nombres.length).toBeGreaterThan(0);
    });

    test.each(nombres)('tool "%s" no ejecuta SQL inválido contra el esquema', async (name) => {
        try {
            await runTool(name, pool, RID, ARGS);
        } catch (err) {
            const msg = (err && err.message) ? err.message : String(err);
            if (SCHEMA_ERROR.test(msg)) {
                throw new Error(`La tool "${name}" ejecuta SQL inválido contra el esquema: ${msg}`, { cause: err });
            }
            // Otros errores (arg, dato no encontrado, etc.) NO son de esquema → se toleran.
        }
    });
});
