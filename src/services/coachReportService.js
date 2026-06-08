/**
 * coachReportService.js — Health Check semanal del Asistente IA
 *
 * Genera un report con 3 cards (crítico, oportunidad, acción) usando Claude
 * con tools del chat. Se cachea por semana ISO en la tabla coach_reports
 * para que múltiples pulsadas del botón en la misma semana NO consuman
 * tokens repetidamente.
 *
 * Diseñado como complemento del Chat IA add-on (mismo gate chat_addon).
 * No usa cuota mensual de consultas — el botón es bajo demanda, no
 * conversación tradicional.
 */

const Anthropic = require('@anthropic-ai/sdk').default;
const { log } = require('../utils/logger');
const { MODEL } = require('./chatService');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const client = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const MAX_TOKENS = 1500;
const MAX_AGENT_ITERATIONS = 6;

/**
 * Devuelve el identificador de la semana ISO (ej. "2026-W22") para una fecha
 * dada. Lunes es el primer día de la semana ISO.
 */
function semanaISO(date = new Date()) {
    // Algoritmo ISO 8601: la semana 1 es la que contiene el primer jueves del año.
    const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNr = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNr + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
    const weekNumber = 1 + Math.round((target - firstThursday) / (7 * 24 * 60 * 60 * 1000));
    const year = target.getUTCFullYear();
    return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}

function buildCoachSystemPrompt(moneda) {
    const simbolo = moneda || '€';
    return `Eres el Asistente IA Coach de un restaurante usando MindLoop CostOS.
Tu trabajo: generar un Health Check semanal con EXACTAMENTE 3 cards (crítico, oportunidad, acción).

La moneda de este restaurante es: ${simbolo}

═══════════════════════════════════════════════════════════
📋 ESTRUCTURA OBLIGATORIA DEL REPORT
═══════════════════════════════════════════════════════════

Devuelves JSON con esta forma EXACTA (sin markdown wrapping, JSON puro):

{
  "critico": {
    "titulo": "Título breve (max 80 chars, incluye 1 cifra concreta)",
    "detalle": "Explicación 2-3 frases. Incluye cifras de las tools. Termina con acción sugerida concreta."
  },
  "oportunidad": {
    "titulo": "...",
    "detalle": "..."
  },
  "accion": {
    "titulo": "...",
    "detalle": "..."
  }
}

═══════════════════════════════════════════════════════════
🎯 CRITERIOS PARA CADA CARD
═══════════════════════════════════════════════════════════

🔴 CRÍTICO — problema que requiere atención ya:
   - Receta con food cost > 40% (rentabilidad rota)
   - Ingrediente sin stock que afecta a recetas vendidas
   - Pedidos pendientes hace > 7 días sin recibir
   - Stock muy desbalanceado (compras >> consumo teórico)

🟢 OPORTUNIDAD — algo positivo sin aprovechar:
   - Receta con margen alto (>65%) pero pocas ventas
   - Ingrediente con stock alto, poco usado, que se puede promocionar
   - Categoría con food cost muy bajo, susceptible de mejor precio
   - Proveedor con buen precio frente a histórico

🔵 ACCIÓN — tarea de mantenimiento concreta:
   - Inventario físico pendiente (>30 días sin recuento)
   - Recetas sin escandallo completo
   - Ingredientes duplicados a fusionar
   - Mermas sin registrar de la semana pasada

═══════════════════════════════════════════════════════════
⚠️ REGLAS ESTRICTAS
═══════════════════════════════════════════════════════════

1. USA tools obligatoriamente antes de responder. NUNCA inventes cifras.
   Mínimo recomendado: resumen_food_cost_recetas + stock_critico + 1-2 diagnostico_*
2. SOLO 3 cards. Si no encuentras una clase (ej. cero críticos), sustituye
   por una oportunidad o acción adicional (siempre 3 totales).
3. Cada card debe ser ACCIONABLE. "Tienes food cost 33%" no vale.
   "Tu plato X tiene food cost 47% — sube precio 2${simbolo} o cambia ingrediente Y" sí.
4. MONEDA OBLIGATORIA: toda cifra monetaria DEBE llevar el símbolo "${simbolo}"
   pegado al número, sin espacio. Ejemplos correctos: "22${simbolo}/ración",
   "8,46${simbolo} margen", "coste botella 10${simbolo}", "precio venta 20${simbolo}".
   INCORRECTO y prohibido: "22 /ración", "8,46 margen", "10 ,", "20 )".
   Aplica también a rangos: "12${simbolo} 13${simbolo}" (NO "12 13").
5. Cita SIEMPRE cifras de las tools con sus unidades (${simbolo}, %, kg, unidades).
6. JSON PURO sin code fences, sin texto extra antes o después.
7. Lenguaje directo, sin emojis dentro del JSON (los pone el frontend).
`;
}

/**
 * Genera el contenido de un report usando Claude + tools del chat.
 * Devuelve el objeto JSON parseado con las 3 cards.
 */
async function generateReportContent(pool, restauranteId, restauranteNombre, moneda) {
    if (!client) {
        throw new Error('Claude API not configured');
    }

    const { TOOLS, runTool } = require('./chatService');

    const messages = [
        {
            role: 'user',
            content: `Genera el Health Check semanal del restaurante "${restauranteNombre}". Usa las tools para extraer datos reales y devuelve el JSON con las 3 cards (critico/oportunidad/accion) según las reglas del system prompt. Moneda: ${moneda}.`
        }
    ];

    let finalText = '';
    const systemPrompt = buildCoachSystemPrompt(moneda);

    for (let iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: systemPrompt,
            tools: TOOLS,
            messages
        });

        if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
            finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
            break;
        }

        if (response.stop_reason === 'tool_use') {
            messages.push({ role: 'assistant', content: response.content });
            const toolResults = [];
            for (const block of response.content) {
                if (block.type === 'tool_use') {
                    try {
                        const result = await runTool(block.name, pool, restauranteId, block.input || {});
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: block.id,
                            content: JSON.stringify(result)
                        });
                    } catch (err) {
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: block.id,
                            content: JSON.stringify({ error: err.message }),
                            is_error: true
                        });
                    }
                }
            }
            messages.push({ role: 'user', content: toolResults });
            continue;
        }

        // Stop reason inesperado — usar lo que haya
        finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        break;
    }

    if (!finalText) {
        throw new Error('Coach: respuesta vacía del modelo');
    }

    // Robusto: a veces Claude devuelve el JSON dentro de ```json ... ```
    let jsonText = finalText;
    const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();

    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch (err) {
        log('error', 'Coach: JSON inválido', { restauranteId, raw: finalText.slice(0, 500) });
        throw new Error('Coach: el modelo no devolvió JSON válido', { cause: err });
    }

    // Validación mínima de estructura
    for (const key of ['critico', 'oportunidad', 'accion']) {
        if (!parsed[key] || typeof parsed[key].titulo !== 'string' || typeof parsed[key].detalle !== 'string') {
            throw new Error(`Coach: falta campo ${key} en la respuesta`);
        }
    }

    return parsed;
}

/**
 * Devuelve el report de la semana actual. Si ya existe en BD, lo devuelve
 * sin regenerar. Si no, lo genera, lo guarda, y marca leido_at.
 */
async function getOrCreateWeeklyReport(pool, restauranteId, restauranteNombre = '', moneda = '€') {
    const semana = semanaISO();

    // 1. Buscar cacheado
    const cached = await pool.query(
        `SELECT id, semana_iso, critico_titulo, critico_detalle,
                oportunidad_titulo, oportunidad_detalle,
                accion_titulo, accion_detalle,
                generado_at, leido_at
         FROM coach_reports
         WHERE restaurante_id = $1 AND semana_iso = $2`,
        [restauranteId, semana]
    );

    if (cached.rows.length > 0) {
        const row = cached.rows[0];
        // Marcar como leído si era la primera vez
        if (!row.leido_at) {
            // 🛡️ Defense-in-depth: añadir restaurante_id al WHERE aunque row.id
            // viene de un SELECT scoped (linea 213) — Iker 2026-06-08.
            await pool.query(
                'UPDATE coach_reports SET leido_at = NOW() WHERE id = $1 AND restaurante_id = $2',
                [row.id, restauranteId]
            );
        }
        return formatReport(row);
    }

    // 2. Generar nuevo
    const content = await generateReportContent(pool, restauranteId, restauranteNombre, moneda);

    // 3. Persistir
    const insertResult = await pool.query(
        `INSERT INTO coach_reports
            (restaurante_id, semana_iso,
             critico_titulo, critico_detalle,
             oportunidad_titulo, oportunidad_detalle,
             accion_titulo, accion_detalle,
             raw_response, leido_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (restaurante_id, semana_iso) DO UPDATE SET
             leido_at = NOW()
         RETURNING id, semana_iso,
                   critico_titulo, critico_detalle,
                   oportunidad_titulo, oportunidad_detalle,
                   accion_titulo, accion_detalle,
                   generado_at, leido_at`,
        [
            restauranteId, semana,
            content.critico.titulo, content.critico.detalle,
            content.oportunidad.titulo, content.oportunidad.detalle,
            content.accion.titulo, content.accion.detalle,
            content
        ]
    );

    return formatReport(insertResult.rows[0]);
}

/**
 * Indica si hay report nuevo (sin leer) para esta semana.
 * No genera nada — solo lectura barata.
 */
async function getReportStatus(pool, restauranteId) {
    const semana = semanaISO();
    const result = await pool.query(
        `SELECT id, semana_iso, generado_at, leido_at
         FROM coach_reports
         WHERE restaurante_id = $1 AND semana_iso = $2`,
        [restauranteId, semana]
    );

    const hoy = new Date();
    const esLunes = hoy.getDay() === 1;

    if (result.rows.length === 0) {
        // Aún no se ha generado esta semana
        return { has_new: esLunes, semana_iso: semana, generado_at: null };
    }

    const row = result.rows[0];
    return {
        has_new: !row.leido_at,
        semana_iso: row.semana_iso,
        generado_at: row.generado_at
    };
}

function formatReport(row) {
    return {
        id: row.id,
        semana_iso: row.semana_iso,
        critico: { titulo: row.critico_titulo, detalle: row.critico_detalle },
        oportunidad: { titulo: row.oportunidad_titulo, detalle: row.oportunidad_detalle },
        accion: { titulo: row.accion_titulo, detalle: row.accion_detalle },
        generado_at: row.generado_at,
        leido_at: row.leido_at
    };
}

module.exports = {
    getOrCreateWeeklyReport,
    getReportStatus,
    semanaISO  // exportada para tests
};
