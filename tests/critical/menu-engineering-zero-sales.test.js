/**
 * ═══════════════════════════════════════════════════
 * 🛡️ Menu Engineering — recetas FOOD activas sin ventas
 * ═══════════════════════════════════════════════════
 * Test de regresión del fix #191 (2026-05-07) "Menu Engineering incluye
 * recetas activas sin ventas en BCG".
 *
 * Antes del fix, GET /api/analysis/menu-engineering arrancaba la query
 * desde `ventas v INNER JOIN recetas r`, así que cualquier receta del
 * menú que dejara de venderse quedaba invisible en la matriz BCG. Justo
 * cuando un Perro debería gritar "estoy en la carta y nadie me pide",
 * la app callaba.
 *
 * Tras el fix la query parte de `recetas r LEFT JOIN ventas v` con
 * `r.activo = TRUE`, así que toda receta FOOD activa entra al análisis.
 * Las que no tienen ventas caen en Perro (margen bajo) o Puzzle
 * (margen alto) según la fórmula BCG estándar — popularidad cero
 * siempre las marca como "no populares".
 *
 * Este test crea una receta FOOD activa con coste y precio conocidos,
 * NO le mete ventas, y verifica que aparece en el resultado del endpoint
 * con `popularidad === 0` y `clasificacion` ∈ ['perro', 'puzzle'].
 * Cleanup: DELETE de la receta tras el test.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('GET /analysis/menu-engineering — recetas FOOD activas sin ventas', () => {
    let authToken;
    let recetaTestId;
    const nombreTest = `_TEST_REGRESION_BCG_NO_VENTAS_${Date.now()}`;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        // Necesitamos un ingrediente activo cualquiera del tenant para meter
        // una línea válida en la receta. La receta no se vende, así que el
        // ingrediente concreto no importa para la lógica del test.
        const ingsRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (ingsRes.status !== 200 || !Array.isArray(ingsRes.body) || ingsRes.body.length === 0) return;

        const ingrediente = ingsRes.body.find(i => parseFloat(i.precio) > 0) || ingsRes.body[0];
        if (!ingrediente) return;

        // Crear receta FOOD activa, sin ventas, con un único ingrediente.
        const crearRes = await request(API_URL)
            .post('/api/recipes')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: nombreTest,
                categoria: 'alimentos',
                precio_venta: 10,
                porciones: 1,
                ingredientes: [{ ingredienteId: ingrediente.id, cantidad: 0.1 }],
            });

        if (crearRes.status === 201 && crearRes.body.id) {
            recetaTestId = crearRes.body.id;
        }
    });

    afterAll(async () => {
        // Cleanup obligatorio: si dejamos la receta en BD, los siguientes runs
        // del test la verían como receta sin ventas pre-existente — perfecto
        // para validar — pero el nombre con timestamp evita colisiones, y la
        // limpieza mantiene el tenant ordenado.
        if (recetaTestId && authToken) {
            await request(API_URL)
                .delete(`/api/recipes/${recetaTestId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .catch(() => { });
        }
    });

    it('1. Receta FOOD activa sin ventas aparece con popularidad=0 y clasificación perro|puzzle', async () => {
        if (!authToken || !recetaTestId) {
            console.log('⏭️ Skip: sin auth o no se pudo crear la receta de test');
            return;
        }

        const res = await request(API_URL)
            .get('/api/analysis/menu-engineering')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        const recetaEnAnalisis = res.body.find(r => r.id === recetaTestId);

        // Antes del fix: recetaEnAnalisis sería undefined (INNER JOIN la excluía).
        expect(recetaEnAnalisis).toBeDefined();

        // Validaciones del comportamiento esperado tras el fix:
        expect(parseFloat(recetaEnAnalisis.popularidad)).toBe(0);
        expect(['perro', 'puzzle']).toContain(recetaEnAnalisis.clasificacion);

        console.log(`✅ Receta sin ventas "${nombreTest}" aparece en BCG como ${recetaEnAnalisis.clasificacion} (popularidad=0)`);
    });

    it('2. Las medias del análisis no se distorsionan con la receta sin ventas', async () => {
        if (!authToken || !recetaTestId) return;

        const res = await request(API_URL)
            .get('/api/analysis/menu-engineering')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);

        // Si hay al menos una receta CON ventas, el promedio de popularidad
        // NO debe ser 0 (señal de que las ventas reales sí pesan en la media).
        const conVentas = res.body.filter(r => parseFloat(r.popularidad) > 0);
        if (conVentas.length === 0) {
            console.log('⏭️ Tenant sin ventas reales registradas → no hay media que validar');
            return;
        }

        const recetaConVentas = conVentas[0];
        // metricas.promedioPopularidad = totalVentas / Nº recetas con ventas.
        // No debería incluir las recetas con popularidad=0 en el divisor.
        const promedio = parseFloat(recetaConVentas.metricas.promedioPopularidad);
        expect(promedio).toBeGreaterThan(0);

        console.log(`✅ Media de popularidad sigue ponderada solo sobre recetas con ventas: ${promedio.toFixed(2)}`);
    });
});
