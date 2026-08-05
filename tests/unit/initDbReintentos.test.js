/**
 * Reintentos de conexión+migraciones en el arranque.
 *
 * Avería origen (staging 2026-08-05): redeploy simultáneo de API y BD → la
 * primera conexión caducó → el arranque se saltó TODAS las migraciones en
 * silencio y el API sirvió tráfico sin la tabla nueva. Estos tests blindan
 * que ahora se reintenta y que las migraciones corren UNA vez al conectar.
 */
const { initializeDatabaseConReintentos } = require('../../src/db/init');

// esperar inyectado: sin sleeps reales, guardamos los ms pedidos
const esperas = [];
const esperar = async (ms) => { esperas.push(ms); };

const poolQueFallaVeces = (fallos) => {
    let llamadas = 0;
    return {
        llamadas: () => llamadas,
        query: async () => {
            llamadas++;
            if (llamadas <= fallos) throw new Error('Connection terminated due to connection timeout');
            return { rows: [{ now: new Date() }] };
        }
    };
};

beforeEach(() => { esperas.length = 0; });

describe('initializeDatabaseConReintentos', () => {
    test('la BD tarda en despertar (2 fallos): reintenta y migra UNA vez', async () => {
        const pool = poolQueFallaVeces(2);
        const inicializar = jest.fn().mockResolvedValue(undefined);

        const ok = await initializeDatabaseConReintentos(pool, { esperar, inicializar });

        expect(ok).toBe(true);
        expect(pool.llamadas()).toBe(3);              // 2 fallos + 1 éxito
        expect(inicializar).toHaveBeenCalledTimes(1); // migraciones UNA vez
        expect(esperas).toEqual([3000, 6000]);        // backoff exponencial
    });

    test('a la primera: sin esperas, migra directo (camino normal de siempre)', async () => {
        const pool = poolQueFallaVeces(0);
        const inicializar = jest.fn().mockResolvedValue(undefined);

        const ok = await initializeDatabaseConReintentos(pool, { esperar, inicializar });

        expect(ok).toBe(true);
        expect(esperas).toEqual([]);
        expect(inicializar).toHaveBeenCalledTimes(1);
    });

    test('BD caída del todo: agota intentos, devuelve false y NUNCA migra a medias', async () => {
        const pool = poolQueFallaVeces(Infinity);
        const inicializar = jest.fn();

        const ok = await initializeDatabaseConReintentos(pool, { esperar, inicializar, intentos: 4 });

        expect(ok).toBe(false);
        expect(pool.llamadas()).toBe(4);
        expect(inicializar).not.toHaveBeenCalled();
        expect(esperas).toEqual([3000, 6000, 12000]); // tras el último fallo no se espera
    });

    test('el backoff se acota al máximo (no esperas eternas)', async () => {
        const pool = poolQueFallaVeces(Infinity);
        await initializeDatabaseConReintentos(pool, { esperar, inicializar: jest.fn(), intentos: 7 });
        expect(esperas).toEqual([3000, 6000, 12000, 24000, 30000, 30000]); // cap en 30s
    });

    test('si las MIGRACIONES fallan (no la conexión), también reintenta', async () => {
        // Conexión OK siempre, pero init falla la 1ª vez (ej: lock de otra instancia)
        const pool = poolQueFallaVeces(0);
        const inicializar = jest.fn()
            .mockRejectedValueOnce(new Error('deadlock'))
            .mockResolvedValueOnce(undefined);

        const ok = await initializeDatabaseConReintentos(pool, { esperar, inicializar });

        expect(ok).toBe(true);
        expect(inicializar).toHaveBeenCalledTimes(2);
    });
});
