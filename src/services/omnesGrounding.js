'use strict';
/**
 * Blindaje de fundamentación numérica de Omnes ("grounded numbers guard").
 *
 * Principio: Omnes NUNCA debe emitir una cifra dura (conteo, total, %, media,
 * food cost) que no proceda de una tool ejecutada en ese turno. Este módulo es
 * PURO (sin LLM, sin BD) y por tanto testeable: extrae los números de la
 * respuesta final, extrae los números de todos los tool_result del turno, y
 * decide si cada cifra de la respuesta está fundamentada (aparece en una tool,
 * o es derivable por una operación simple de dos números de tools).
 *
 * Formatos numéricos: la app usa es-ES (miles ".", decimal ",") en el texto,
 * mientras que los tool_result son JSON con floats estándar (decimal "."). Se
 * normaliza todo a Number para comparar.
 */

// Modo desde entorno: 'off' | 'log' | 'block'. Por defecto 'log' (solo mide).
function groundingMode() {
    const m = (process.env.OMNES_GROUNDING_MODE || 'log').toLowerCase().trim();
    return (m === 'off' || m === 'log' || m === 'block') ? m : 'log';
}

const MAX_GROUNDING_RETRIES = 2;

// Sustantivos de conteo: "23 pedidos", "216 pedidos", "2 platos", "3 fugas"...
const COUNT_NOUNS = [
    'pedidos', 'ventas', 'tickets', 'platos', 'raciones', 'unidades', 'uds',
    'proveedores', 'ingredientes', 'recetas', 'compras', 'mermas', 'registros',
    'clientes', 'comensales', 'cubiertos', 'fugas', 'días', 'dias'
].join('|');

function round(x, d) {
    const p = Math.pow(10, d);
    return Math.round(x * p) / p;
}

function decimalsOf(raw) {
    // decimales mostrados en el texto es-ES (la coma es el separador decimal)
    const m = String(raw).match(/,(\d+)/);
    if (m) return m[1].length;
    // formato inglés "12.44" (sin miles): un punto seguido de <=2 dígitos
    const e = String(raw).match(/^\D*\d+\.(\d{1,2})\D*$/);
    return e ? e[1].length : 0;
}

/** Convierte un string numérico (es-ES o estándar) a Number, o null. */
function toFloat(raw) {
    if (raw == null) return null;
    let s = String(raw).trim().replace(/[€$%\s]|RM|USD/gi, '').trim();
    if (!s) return null;
    const hasComma = s.indexOf(',') >= 0;
    const hasDot = s.indexOf('.') >= 0;
    if (hasComma && hasDot) {
        // el último separador es el decimal
        if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
        else s = s.replace(/,/g, '');
    } else if (hasComma) {
        s = s.replace(',', '.'); // coma decimal
    } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
        s = s.replace(/\./g, ''); // puntos de miles: 3.387 -> 3387
    }
    const f = parseFloat(s);
    return Number.isFinite(f) ? f : null;
}

/** Recorre un valor JSON y acumula todos los números (leaf numbers + los embebidos en strings). */
function walkNumbers(v, add) {
    if (v == null) return;
    if (typeof v === 'number') { add(v); return; }
    if (typeof v === 'string') {
        const m = v.match(/-?\d[\d.,]*/g);
        if (m) m.forEach(x => { const f = toFloat(x); if (f != null) add(f); });
        return;
    }
    if (Array.isArray(v)) { v.forEach(x => walkNumbers(x, add)); return; }
    if (typeof v === 'object') { Object.values(v).forEach(x => walkNumbers(x, add)); }
}

/** Todos los números presentes en los tool_result de los mensajes de este turno. */
function collectToolNumbers(messages) {
    const set = new Set();
    const add = (n) => { if (Number.isFinite(n)) set.add(round(n, 4)); };
    for (const msg of messages || []) {
        if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
            if (block && block.type === 'tool_result' && typeof block.content === 'string') {
                try { walkNumbers(JSON.parse(block.content), add); }
                catch (_) {
                    const m = block.content.match(/-?\d[\d.,]*/g);
                    if (m) m.forEach(x => { const f = toFloat(x); if (f != null) add(f); });
                }
            }
        }
    }
    return Array.from(set);
}

/** Extrae las cifras duras de la respuesta final: importes, porcentajes y conteos. */
function extractHardNumbers(text) {
    const out = [];
    const seen = new Set();
    const push = (raw, value, kind) => {
        if (value == null || !Number.isFinite(value)) return;
        const k = kind + '|' + raw;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ raw: raw.trim(), value, kind, decimals: decimalsOf(raw) });
    };
    if (!text) return out;
    let m;
    // Importes: número + símbolo, o símbolo + número
    const reCur = /(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:[.,]\d+)?)\s?(€|RM|\$|USD)|(€|\$|RM)\s?(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:[.,]\d+)?)/g;
    while ((m = reCur.exec(text))) push(m[0], toFloat(m[1] || m[4]), 'money');
    // Porcentajes
    const reP = /(\d+(?:[.,]\d+)?)\s?%/g;
    while ((m = reP.exec(text))) push(m[0], toFloat(m[1]), 'percent');
    // Conteos: número + sustantivo de conteo
    const reC = new RegExp('(\\d{1,3}(?:\\.\\d{3})*|\\d+)\\s+(?:' + COUNT_NOUNS + ')', 'gi');
    while ((m = reC.exec(text))) push(m[0], toFloat(m[1]), 'count');
    // Enteros "sueltos" >= 10 (posibles conteos), excluidos años y los ya capturados
    const reB = /(?<![\d.,/€$%-])(\d{2,})(?![\d.,%/]|\s?(?:€|RM|\$|%))/g;
    while ((m = reB.exec(text))) {
        const v = toFloat(m[1]);
        if (v == null || v < 10 || (v >= 1990 && v <= 2099)) continue;
        push(m[1], v, 'count');
    }
    return out;
}

function tolFor(kind, v) {
    if (kind === 'percent') return 0.15;                 // ±0,15 puntos
    if (kind === 'money') return Math.max(0.5, Math.abs(v) * 0.005); // redondeo / ±0,5%
    return 0.001;                                        // conteos: exactos
}

/** ¿La cifra `item` está fundamentada en `toolNums` (directa o derivable)? */
function isGrounded(item, toolNums) {
    const { value, kind, decimals } = item;
    const tol = tolFor(kind, value);
    const near = (a, b) => Math.abs(a - b) <= tol;
    // 1) directa (con redondeo a los decimales mostrados)
    for (const t of toolNums) {
        if (near(value, t)) return true;
        if (decimals != null && round(t, decimals) === value) return true;
    }
    // 2) derivable por operación simple entre dos números de tools
    //    (margen = precio − coste; food cost % = coste/precio*100; sumas; múltiplos)
    if (toolNums.length <= 120) {
        for (const t of toolNums) {
            for (let k = 1; k <= 12; k++) if (near(value, t * k)) return true; // múltiplos/uds
        }
        for (let i = 0; i < toolNums.length; i++) {
            const a = toolNums[i];
            for (let j = 0; j < toolNums.length; j++) {
                if (i === j) continue;
                const b = toolNums[j];
                if (near(value, a - b) || near(value, a + b)) return true;
                if (b !== 0) {
                    if (near(value, a / b)) return true;
                    if (kind === 'percent' && near(value, (a / b) * 100)) return true;
                }
            }
        }
    }
    return false;
}

/**
 * Verifica la respuesta final contra los tool_result del turno.
 * @returns {{ ok:boolean, ungrounded:Array, checked:number, toolNums:number }}
 */
function verifyAnswer(finalText, messages) {
    const toolNums = collectToolNumbers(messages);
    const nums = extractHardNumbers(finalText);
    // Si no hubo NINGUNA tool en el turno, no verificamos (pregunta conversacional);
    // pero si la respuesta trae cifras duras sin tools, esas SÍ son sospechosas.
    const ungrounded = nums.filter(n => !isGrounded(n, toolNums));
    return { ok: ungrounded.length === 0, ungrounded, checked: nums.length, toolNums: toolNums.length };
}

/** Mensaje correctivo para forzar el re-query en modo 'block'. */
function correctionMessage(ungrounded) {
    const lista = ungrounded.map(u => u.raw).join(', ');
    return `⚠️ AUTO-VERIFICACIÓN INTERNA: estas cifras de tu respuesta NO aparecen en ningún resultado de herramienta de este turno: ${lista}. ` +
        `Obténlas con la tool de agregado exacta (resumen_ventas_periodo / resumen_compras_periodo / resumen_pyg / resumen_inventario / resumen_mermas / diagnostico_*) ANTES de responder, ` +
        `o elimina esa afirmación. Prohibido estimar, recordar o contar a mano. Responde de nuevo solo con cifras fundamentadas.`;
}

module.exports = {
    groundingMode,
    MAX_GROUNDING_RETRIES,
    toFloat,
    decimalsOf,
    collectToolNumbers,
    extractHardNumbers,
    isGrounded,
    verifyAnswer,
    correctionMessage,
};
