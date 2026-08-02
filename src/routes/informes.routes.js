/**
 * Informes Routes — el informe mensual, fuera del chat.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO (2026-08-02, rama `lite`):
 * El informe mensual vivía dentro de `chat.routes.js`, así que para quitar el
 * chat de Omnes en la casa Lite había que desmontar ese router entero... y el
 * informe se iba con él. Y el informe SÍ lo queremos en Lite: es la pieza que
 * le da valor sin darle un asistente conversacional.
 *
 * Sacándolo aquí, cada casa monta lo que le toca:
 *   · Lite       → `informes` sí, `chat` NO.
 *   · App grande → las dos (Omnes incluido).
 *
 * DIFERENCIA COMERCIAL (decisión de Iker): Lite recibe UN informe al mes, a
 * golpe de botón. La app grande tiene además el chat, con su cuota mensual de
 * consultas. Son productos distintos: uno es un entregable, el otro es poder
 * preguntar lo que quieras cuando quieras. Por eso el informe en Lite no
 * canibaliza a Omnes — y en coste es una llamada al mes, no trescientas.
 *
 * RUTAS
 *   GET /api/informes/mensual[?mes=YYYY-MM]        → JSON con los datos (SQL puro, 0 €)
 *   GET /api/informes/mensual/html[?mes&lang]      → HTML narrado (1 llamada a Claude)
 *
 * Se mantienen los alias antiguos `/api/chat/informe-mensual[...]` porque el
 * frontend desplegado todavía los llama: cambiar la URL y el frontend a la vez
 * habría sido romper dos cosas para arreglar una. Los alias se pueden retirar
 * cuando ningún cliente sirva bundles viejos.
 */

const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { costlyApiLimiter } = require('../middleware/rateLimit');
const { log } = require('../utils/logger');
const { generarInformeMensual } = require('../services/informeMensualService');
const { generarInformeHtml } = require('../services/informeMensualHtml');

module.exports = function (pool) {
    const router = Router();

    /**
     * Datos del informe. Solo lectura y SIN coste de tokens: todo sale de SQL.
     * No pasa por el gate del addon de chat porque no consume cuota de Claude.
     */
    async function datosMensuales(req, res) {
        const restauranteId = req.restauranteId;
        if (!restauranteId) {
            return res.status(401).json({ error: 'No restaurante asociado al usuario' });
        }
        const mes = req.query.mes; // 'YYYY-MM' opcional
        try {
            const informe = await generarInformeMensual(pool, restauranteId, mes);
            res.json(informe);
        } catch (err) {
            log('error', 'informes/mensual failed', { restauranteId, mes, error: err.message });
            res.status(500).json({ error: 'Error generando datos del informe' });
        }
    }

    /**
     * Informe completo en HTML, listo para imprimir o guardar como PDF desde el
     * navegador. Hace UNA llamada a Claude (single-shot, sin tools) solo para la
     * parte narrativa; los números salen del servicio de datos.
     *
     * No incrementa el contador de consultas del chat: un informe no es una
     * conversación, y en Lite ni siquiera hay chat que contar.
     */
    async function htmlMensual(req, res) {
        const restauranteId = req.restauranteId;
        if (!restauranteId) {
            return res.status(401).json({ error: 'No restaurante asociado al usuario' });
        }
        const mes = req.query.mes;
        const lang = req.query.lang === 'en' ? 'en' : 'es';
        try {
            const r = await pool.query(
                'SELECT nombre, moneda FROM restaurantes WHERE id = $1',
                [restauranteId]
            );
            const row = r.rows[0] || {};
            const datos = await generarInformeMensual(pool, restauranteId, mes);
            const { html, usage } = await generarInformeHtml({
                datos,
                restauranteNombre: row.nombre || '',
                moneda: row.moneda || '€',
                lang
            });
            log('info', 'Informe mensual HTML generado', {
                restauranteId, mes: datos.periodo.mes,
                tokensInput: usage.input, tokensOutput: usage.output
            });
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.send(html);
        } catch (err) {
            log('error', 'informes/mensual/html failed', {
                restauranteId, mes, error: err.message, stack: err.stack
            });
            res.status(500).json({ error: 'Error generando informe HTML' });
        }
    }

    // Rutas nuevas
    router.get('/informes/mensual', authMiddleware, datosMensuales);
    router.get('/informes/mensual/html', costlyApiLimiter, authMiddleware, htmlMensual);

    // Alias legacy — los llama el frontend ya desplegado. Mismo handler, misma
    // respuesta: no hay dos implementaciones que puedan divergir.
    router.get('/chat/informe-mensual', authMiddleware, datosMensuales);
    router.get('/chat/informe-mensual/html', costlyApiLimiter, authMiddleware, htmlMensual);

    return router;
};
