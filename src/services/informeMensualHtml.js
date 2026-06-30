/**
 * informeMensualHtml — compone el informe ejecutivo mensual en HTML.
 *
 * Flujo:
 *   1. Recibe el JSON crudo de generarInformeMensual()
 *   2. Llama a Claude (sin tools, single shot) pidiendo un JSON estructurado
 *      con resumen ejecutivo, observaciones y recomendaciones
 *   3. Renderiza un HTML listo para imprimir / guardar como PDF desde el
 *      navegador (window.print() con @media print).
 *
 * Por qué backend renderiza el HTML (en vez de que lo haga Claude):
 *   - Control total de CSS (consistencia con la app)
 *   - @media print fiable
 *   - Multi-moneda sin que Claude tenga que acordarse del símbolo
 *   - El cliente paga por análisis, no por HTML mal formateado
 *
 * Claude SOLO genera la parte narrativa (resumen + observaciones +
 * recomendaciones). Los datos numéricos vienen tal cual del informe.
 */

const Anthropic = require('@anthropic-ai/sdk').default;
const { log } = require('../utils/logger');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2000;

const client = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmtMoneda(value, moneda) {
    const n = parseFloat(value);
    const safe = isFinite(n) ? n : 0;
    // Símbolo antes para RM/USD, después para € (es lo más visualmente correcto).
    // Si el valor no es finito (null/NaN/string-no-numérico) caemos a 0 pero
    // respetando el formato canónico de la moneda — el fallback no debe
    // saltarse la regla de posición del símbolo.
    const formatted = safe.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return moneda === '€' ? `${formatted} €` : `${moneda} ${formatted}`;
}

function fmtPct(value) {
    const n = parseFloat(value);
    if (!isFinite(n)) return '—';
    return `${n.toFixed(1)}%`;
}

function fmtVariacion(value) {
    const n = parseFloat(value);
    if (!isFinite(n)) return '—';
    const signo = n > 0 ? '+' : '';
    return `${signo}${n.toFixed(1)}%`;
}

function classFoodCost(pct) {
    const n = parseFloat(pct);
    if (!isFinite(n)) return 'kpi-neutral';
    if (n <= 30) return 'kpi-good';
    if (n <= 35) return 'kpi-warn';
    if (n <= 40) return 'kpi-orange';
    return 'kpi-bad';
}

/**
 * Pide a Claude un análisis narrativo del informe. Devuelve un objeto
 * con resumen, observaciones y recomendaciones. Si la API falla,
 * devolvemos un análisis de fallback (no inventado, solo descriptivo).
 */
async function pedirAnalisisIA({ datos, restauranteNombre, moneda, lang }) {
    if (!client) {
        throw new Error('ANTHROPIC_API_KEY no configurada');
    }

    const system = lang === 'en'
        ? `You are a senior restaurant CFO analyst. Your job: read the monthly KPI dump and write an executive analysis for the restaurant owner.

OUTPUT FORMAT (strict JSON, no markdown fences, no preamble):
{
  "resumen_ejecutivo": "3-4 lines, professional tone, with the key number in **bold** markdown",
  "observaciones": ["3-5 short bullets, factual, with numbers"],
  "recomendaciones": [
    {"titulo": "short action", "detalle": "1-2 lines explaining how", "impacto": "estimated impact (e.g. 'save 200 ${moneda}/mes')"}
  ],
  "alertas": [{"tipo": "warning|critical|info", "mensaje": "..."}]
}

RULES:
- Use the actual numbers from the data, never invent.
- Currency symbol: ${moneda}
- Be concrete: if food cost is 36%, suggest WHICH dishes to reprice (use top_problematicos).
- If a section is empty (no data), don't mention it.
- 2-4 recommendations max, prioritised by impact.
- Tone: executive, direct, no fluff, no apologies.`
        : `Eres un analista financiero senior de restauración. Tu trabajo: leer el dump de KPIs mensual y escribir un análisis ejecutivo para el dueño del restaurante.

FORMATO DE SALIDA (JSON estricto, sin fences markdown, sin preámbulo):
{
  "resumen_ejecutivo": "3-4 líneas, tono profesional, con la cifra clave en **negrita** markdown",
  "observaciones": ["3-5 bullets cortos, factuales, con números"],
  "recomendaciones": [
    {"titulo": "acción corta", "detalle": "1-2 líneas explicando cómo", "impacto": "impacto estimado (ej. 'ahorrar 200 ${moneda}/mes')"}
  ],
  "alertas": [{"tipo": "warning|critical|info", "mensaje": "..."}]
}

REGLAS:
- Usa los números reales del data, nunca inventes.
- Símbolo moneda: ${moneda}
- Sé concreto: si food cost es 36%, sugiere QUÉ platos resubir (usa top_problematicos).
- Si una sección está vacía (sin datos), no la menciones.
- 2-4 recomendaciones máximo, priorizadas por impacto.
- Tono: ejecutivo, directo, sin floritura, sin disculpas.`;

    const userMessage = lang === 'en'
        ? `Restaurant: ${restauranteNombre}\nMonth: ${datos.periodo.mes}\nPrevious month: ${datos.periodo.mes_anterior}\n\nFULL DATA:\n${JSON.stringify(datos, null, 2)}`
        : `Restaurante: ${restauranteNombre}\nMes: ${datos.periodo.mes}\nMes anterior: ${datos.periodo.mes_anterior}\n\nDATOS COMPLETOS:\n${JSON.stringify(datos, null, 2)}`;

    const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: userMessage }]
    });

    const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();

    // El modelo a veces envuelve el JSON en ```json ... ``` aunque le pidamos
    // que no lo haga. Lo saneamos antes de parsear.
    let cleaned = text;
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();

    let analisis;
    try {
        analisis = JSON.parse(cleaned);
    } catch (err) {
        log('warn', 'Claude no devolvió JSON parseable, usando fallback', {
            preview: cleaned.slice(0, 200)
        });
        // Fallback descriptivo (no inventa nada)
        analisis = {
            resumen_ejecutivo: text || (lang === 'en'
                ? 'Monthly executive report — see KPIs below.'
                : 'Informe ejecutivo mensual — consulta los KPIs abajo.'),
            observaciones: [],
            recomendaciones: [],
            alertas: []
        };
    }

    return {
        analisis,
        usage: {
            input: response.usage?.input_tokens || 0,
            output: response.usage?.output_tokens || 0
        }
    };
}

/**
 * Mini markdown → HTML para los textos del análisis (sólo **negrita** y
 * saltos de línea). Sin librería para no añadir deps.
 */
function mdToHtml(str) {
    if (!str) return '';
    return escapeHtml(str)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
}

/**
 * Renderiza un sparkline SVG simple de los ingresos diarios del mes.
 * Sin librerías, polyline manual, autoescala. ~600x80px.
 */
function renderSparkline(datos, moneda, lang) {
    if (!datos || datos.length < 2) return '';
    const W = 600;
    const H = 80;
    const PAD_X = 8;
    const PAD_Y = 8;

    const valores = datos.map(d => parseFloat(d.ingresos) || 0);
    const max = Math.max(...valores, 1);
    const min = 0; // siempre arrancamos en 0 para que la magnitud sea legible
    const innerW = W - PAD_X * 2;
    const innerH = H - PAD_Y * 2;

    const stepX = datos.length > 1 ? innerW / (datos.length - 1) : 0;
    const points = datos.map((d, i) => {
        const x = PAD_X + i * stepX;
        const v = parseFloat(d.ingresos) || 0;
        const y = PAD_Y + innerH - ((v - min) / (max - min)) * innerH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    // Area path: línea + relleno hasta el eje X
    const areaPath = `M ${PAD_X},${PAD_Y + innerH} L ${points.join(' L ')} L ${PAD_X + (datos.length - 1) * stepX},${PAD_Y + innerH} Z`;

    const maxIdx = valores.indexOf(max);
    const maxX = PAD_X + maxIdx * stepX;
    const maxY = PAD_Y + innerH - ((max - min) / (max - min)) * innerH;

    const fmtFecha = (iso) => {
        try {
            const d = new Date(iso + 'T00:00:00Z');
            return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'es-ES', { day: '2-digit', month: 'short' });
        } catch (e) { return iso; }
    };
    const primero = fmtFecha(datos[0].dia);
    const ultimo = fmtFecha(datos[datos.length - 1].dia);

    return `
    <svg viewBox="0 0 ${W} ${H + 22}" preserveAspectRatio="none" style="width:100%; height:110px;" role="img" aria-label="Evolución de ingresos">
        <defs>
            <linearGradient id="sl-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"  stop-color="#1e3a8a" stop-opacity="0.35"/>
                <stop offset="100%" stop-color="#1e3a8a" stop-opacity="0"/>
            </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#sl-area)" stroke="none"/>
        <polyline points="${points.join(' ')}" fill="none" stroke="#1e3a8a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${maxX.toFixed(1)}" cy="${maxY.toFixed(1)}" r="3.5" fill="#f59e0b" stroke="#fff" stroke-width="1.5"/>
        <text x="${PAD_X}" y="${H + 16}" font-size="11" fill="#64748b" font-family="-apple-system, sans-serif">${escapeHtml(primero)}</text>
        <text x="${W - PAD_X}" y="${H + 16}" font-size="11" fill="#64748b" font-family="-apple-system, sans-serif" text-anchor="end">${escapeHtml(ultimo)}</text>
        <text x="${maxX.toFixed(1)}" y="${Math.max(maxY - 6, 14).toFixed(1)}" font-size="11" fill="#f59e0b" font-weight="700" font-family="-apple-system, sans-serif" text-anchor="middle">${escapeHtml(fmtMoneda(max, moneda))}</text>
    </svg>`;
}

function renderHtml({ datos, analisis, restauranteNombre, moneda, lang }) {
    const T = lang === 'en' ? {
        titulo: 'Monthly Executive Report',
        periodo: 'Period',
        ingresos: 'Revenue',
        foodCost: 'Food Cost',
        cogs: 'COGS',
        variacionMes: 'vs previous month',
        kpis: 'Key Indicators',
        resumen: 'Executive Summary',
        observaciones: 'Observations',
        recomendaciones: 'Recommendations',
        impacto: 'Impact',
        topRentables: 'Most Profitable Dishes',
        topProblematicos: 'High Food Cost Dishes',
        cambiosPrecio: 'Significant Price Changes',
        stock: 'Inventory',
        alertas: 'Alerts',
        plato: 'Dish',
        vendidas: 'Sold',
        margen: 'Margin',
        ingrediente: 'Ingredient',
        precioActual: 'Current',
        precioAnterior: 'Previous',
        variacion: 'Change',
        valorTotal: 'Total value',
        bajoMinimo: 'Below minimum',
        sinStock: 'Out of stock',
        generadoEl: 'Generated on',
        imprimir: 'Print / Save as PDF',
        sinDatos: 'No data',
        pyg: 'P&L — Profit & Loss',
        pygIngresos: 'Revenue',
        pygCogs: 'COGS (cost of goods sold)',
        pygMargenBruto: 'Gross margin',
        pygGastosFijos: 'Fixed costs',
        pygComidaPersonal: 'Staff meals',
        pygPersonalExtra: 'Extra staff',
        pygBeneficio: 'Net profit',
        pygMargenNeto: 'Net margin',
        topProveedores: 'Top Suppliers',
        proveedor: 'Supplier',
        gastoMes: 'This month',
        gastoAnterior: 'Previous month',
        mermas: 'Losses (waste)',
        mermasValor: 'Total value lost',
        mermasRegistros: 'records',
        mermasMotivo: 'Reason',
        mermasNum: 'Items',
        mermasValorCol: 'Value',
        evolucion: 'Daily revenue evolution',
        sinMermas: 'No waste recorded this month — perfect.',
        foodCostReal: 'Real food cost',
        foodCostRealHint: 'Includes waste losses',
        pygMermas: 'Losses (waste)',
    } : {
        titulo: 'Informe Ejecutivo Mensual',
        periodo: 'Periodo',
        ingresos: 'Ingresos',
        foodCost: 'Food Cost',
        cogs: 'COGS',
        variacionMes: 'vs mes anterior',
        kpis: 'Indicadores Clave',
        resumen: 'Resumen Ejecutivo',
        observaciones: 'Observaciones',
        recomendaciones: 'Recomendaciones',
        impacto: 'Impacto',
        topRentables: 'Platos Más Rentables',
        topProblematicos: 'Platos con Food Cost Alto',
        cambiosPrecio: 'Cambios de Precio Significativos',
        stock: 'Inventario',
        alertas: 'Alertas',
        plato: 'Plato',
        vendidas: 'Vendidas',
        margen: 'Margen',
        ingrediente: 'Ingrediente',
        precioActual: 'Actual',
        precioAnterior: 'Anterior',
        variacion: 'Variación',
        valorTotal: 'Valor total',
        bajoMinimo: 'Bajo mínimo',
        sinStock: 'Sin stock',
        generadoEl: 'Generado el',
        imprimir: 'Imprimir / Guardar PDF',
        sinDatos: 'Sin datos',
        pyg: 'P&L — Cuenta de Resultados',
        pygIngresos: 'Ingresos',
        pygCogs: 'COGS (coste materia prima)',
        pygMargenBruto: 'Margen bruto',
        pygGastosFijos: 'Gastos fijos',
        pygComidaPersonal: 'Comida de personal',
        pygPersonalExtra: 'Personal extra',
        pygBeneficio: 'Beneficio neto',
        pygMargenNeto: 'Margen neto',
        topProveedores: 'Top Proveedores',
        proveedor: 'Proveedor',
        gastoMes: 'Este mes',
        gastoAnterior: 'Mes anterior',
        mermas: 'Mermas (dinero perdido)',
        mermasValor: 'Valor total perdido',
        mermasRegistros: 'registros',
        mermasMotivo: 'Motivo',
        mermasNum: 'Nº',
        mermasValorCol: 'Valor',
        evolucion: 'Evolución diaria de ingresos',
        sinMermas: 'Ningún registro de merma este mes — perfecto.',
        foodCostReal: 'Food cost real',
        foodCostRealHint: 'Incluye pérdidas por mermas',
        pygMermas: 'Mermas (producto perdido)',
    };

    const fechaGen = new Date(datos.periodo.fecha_generacion).toLocaleString(
        lang === 'en' ? 'en-GB' : 'es-ES',
        { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    );

    const variacionIngresos = datos.ingresos.variacion_pct;
    const variacionClass = variacionIngresos === null
        ? 'kpi-neutral'
        : variacionIngresos >= 0 ? 'kpi-good' : 'kpi-bad';

    const fcClass = classFoodCost(datos.food_cost.mes_actual_pct);

    const topRentablesRows = (datos.top_rentables || []).map(r => `
        <tr>
            <td>${escapeHtml(r.nombre)}</td>
            <td class="num">${r.vendidas}</td>
            <td class="num">${fmtMoneda(r.ingresos, moneda)}</td>
            <td class="num">${fmtPct(r.margen_pct)}</td>
        </tr>
    `).join('');

    const topProblematicosRows = (datos.top_problematicos || []).map(r => `
        <tr>
            <td>${escapeHtml(r.nombre)}</td>
            <td class="num">${r.vendidas}</td>
            <td class="num"><span class="${classFoodCost(r.food_cost_pct)}">${fmtPct(r.food_cost_pct)}</span></td>
        </tr>
    `).join('');

    const cambiosPrecioRows = (datos.cambios_precio || []).map(r => {
        const subClass = parseFloat(r.variacion_pct) > 0 ? 'kpi-bad' : 'kpi-good';
        return `
        <tr>
            <td>${escapeHtml(r.ingrediente)}</td>
            <td class="num">${fmtMoneda(r.precio_anterior, moneda)}</td>
            <td class="num">${fmtMoneda(r.precio_actual, moneda)}</td>
            <td class="num"><span class="${subClass}">${fmtVariacion(r.variacion_pct)}</span></td>
        </tr>`;
    }).join('');

    // P&L cascade
    const pyg = datos.pyg || {};
    const benefClass = parseFloat(pyg.beneficio_neto) >= 0 ? 'kpi-good' : 'kpi-bad';
    const margenNetoClass = parseFloat(pyg.margen_neto_pct) >= 10 ? 'kpi-good'
        : parseFloat(pyg.margen_neto_pct) >= 0 ? 'kpi-warn' : 'kpi-bad';
    const pygHtml = `
        <table class="pyg-table">
            <tr><td>${escapeHtml(T.pygIngresos)}</td><td class="num">${fmtMoneda(pyg.ingresos, moneda)}</td></tr>
            <tr class="pyg-minus"><td>− ${escapeHtml(T.pygCogs)}</td><td class="num">${fmtMoneda(pyg.cogs, moneda)}</td></tr>
            <tr class="pyg-subtotal"><td>${escapeHtml(T.pygMargenBruto)}</td><td class="num">${fmtMoneda(pyg.margen_bruto, moneda)}</td></tr>
            <tr class="pyg-minus"><td>− ${escapeHtml(T.pygGastosFijos)} <span class="pyg-sub-info">(${pyg.gastos_fijos_conceptos || 0})</span></td><td class="num">${fmtMoneda(pyg.gastos_fijos, moneda)}</td></tr>
            ${parseFloat(pyg.comida_personal) > 0 ? `<tr class="pyg-minus"><td>− ${escapeHtml(T.pygComidaPersonal)}</td><td class="num">${fmtMoneda(pyg.comida_personal, moneda)}</td></tr>` : ''}
            ${parseFloat(pyg.personal_extra) > 0 ? `<tr class="pyg-minus"><td>− ${escapeHtml(T.pygPersonalExtra)}</td><td class="num">${fmtMoneda(pyg.personal_extra, moneda)}</td></tr>` : ''}
            <tr class="pyg-total"><td><strong>${escapeHtml(T.pygBeneficio)}</strong></td><td class="num"><strong class="${benefClass}">${fmtMoneda(pyg.beneficio_neto, moneda)}</strong></td></tr>
            <tr class="pyg-pct"><td>${escapeHtml(T.pygMargenNeto)}</td><td class="num"><span class="${margenNetoClass}">${fmtPct(pyg.margen_neto_pct)}</span></td></tr>
        </table>
    `;

    // Top proveedores
    const topProveedoresRows = (datos.top_proveedores || []).map(p => {
        const varClass = p.variacion_pct === null ? 'kpi-neutral'
            : parseFloat(p.variacion_pct) > 0 ? 'kpi-bad' : 'kpi-good';
        const varStr = p.variacion_pct === null ? '—' : fmtVariacion(p.variacion_pct);
        return `
        <tr>
            <td>${escapeHtml(p.proveedor)}</td>
            <td class="num">${fmtMoneda(p.gasto_actual, moneda)}</td>
            <td class="num">${fmtMoneda(p.gasto_anterior, moneda)}</td>
            <td class="num"><span class="${varClass}">${varStr}</span></td>
        </tr>`;
    }).join('');

    // Mermas
    const mermas = datos.mermas || {};
    const mermasMotivosRows = (mermas.top_motivos || []).map(m => `
        <tr>
            <td>${escapeHtml(m.motivo)}</td>
            <td class="num">${m.num}</td>
            <td class="num">${fmtMoneda(m.valor, moneda)}</td>
        </tr>
    `).join('');
    const mermasHtml = (mermas.num_registros > 0) ? `
        <div class="mermas-kpi">
            <div class="mermas-kpi-label">${escapeHtml(T.mermasValor)}</div>
            <div class="mermas-kpi-value kpi-bad">${fmtMoneda(mermas.valor_total, moneda)}</div>
            <div class="mermas-kpi-sub">${mermas.num_registros} ${escapeHtml(T.mermasRegistros)}</div>
        </div>
        ${mermasMotivosRows ? `<table>
            <thead><tr>
                <th>${escapeHtml(T.mermasMotivo)}</th>
                <th class="num">${escapeHtml(T.mermasNum)}</th>
                <th class="num">${escapeHtml(T.mermasValorCol)}</th>
            </tr></thead>
            <tbody>${mermasMotivosRows}</tbody>
        </table>` : ''}
    ` : `<div class="empty">${escapeHtml(T.sinMermas)}</div>`;

    // Sparkline
    const sparklineHtml = renderSparkline(datos.evolucion_diaria || [], moneda, lang);

    const observacionesHtml = (analisis.observaciones || [])
        .map(o => `<li>${mdToHtml(o)}</li>`)
        .join('');

    const recomendacionesHtml = (analisis.recomendaciones || [])
        .map(r => `
            <div class="reco">
                <div class="reco-title">${escapeHtml(r.titulo || '')}</div>
                <div class="reco-detalle">${mdToHtml(r.detalle || '')}</div>
                ${r.impacto ? `<div class="reco-impacto"><strong>${T.impacto}:</strong> ${mdToHtml(r.impacto)}</div>` : ''}
            </div>
        `).join('');

    const alertasHtml = (analisis.alertas || []).length === 0 ? '' : `
        <section class="alertas">
            <h2>⚠️ ${T.alertas}</h2>
            ${analisis.alertas.map(a => `
                <div class="alerta alerta-${escapeHtml(a.tipo || 'info')}">${mdToHtml(a.mensaje)}</div>
            `).join('')}
        </section>
    `;

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(T.titulo)} — ${escapeHtml(restauranteNombre)}</title>
<style>
    :root {
        --primary: #1e3a8a;
        --accent: #f59e0b;
        --good: #16a34a;
        --warn: #ca8a04;
        --orange: #ea580c;
        --bad: #dc2626;
        --neutral: #64748b;
        --bg: #f8fafc;
        --card: #ffffff;
        --border: #e2e8f0;
        --text: #0f172a;
        --muted: #64748b;
    }
    * { box-sizing: border-box; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: var(--bg);
        color: var(--text);
        margin: 0;
        padding: 32px 16px 64px;
        line-height: 1.5;
    }
    .container {
        max-width: 880px;
        margin: 0 auto;
    }
    .print-bar {
        display: flex;
        justify-content: flex-end;
        margin-bottom: 16px;
    }
    .btn-print {
        background: var(--primary);
        color: white;
        border: none;
        padding: 10px 20px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
    }
    .btn-print:hover { background: #1e40af; }
    .report {
        background: var(--card);
        border-radius: 12px;
        padding: 40px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    header.cover {
        border-bottom: 3px solid var(--primary);
        padding-bottom: 24px;
        margin-bottom: 32px;
    }
    header.cover h1 {
        margin: 0 0 4px;
        font-size: 28px;
        color: var(--primary);
    }
    header.cover .subtitle {
        font-size: 16px;
        color: var(--muted);
    }
    header.cover .restaurante {
        font-size: 20px;
        font-weight: 600;
        margin-top: 12px;
    }
    .kpi-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 16px;
        margin-bottom: 32px;
    }
    .kpi-card {
        background: #f1f5f9;
        border-radius: 10px;
        padding: 20px;
        text-align: center;
        border: 1px solid var(--border);
    }
    .kpi-label {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--muted);
        margin-bottom: 8px;
    }
    .kpi-value {
        font-size: 26px;
        font-weight: 700;
        color: var(--text);
    }
    .kpi-sub {
        font-size: 12px;
        color: var(--muted);
        margin-top: 4px;
    }
    .kpi-good   { color: var(--good); }
    .kpi-warn   { color: var(--warn); }
    .kpi-orange { color: var(--orange); }
    .kpi-bad    { color: var(--bad); }
    .kpi-neutral { color: var(--neutral); }
    section {
        margin-bottom: 32px;
        page-break-inside: avoid;
    }
    h2 {
        font-size: 18px;
        color: var(--primary);
        margin-bottom: 16px;
        padding-bottom: 6px;
        border-bottom: 2px solid var(--border);
    }
    .resumen {
        background: #fef3c7;
        border-left: 4px solid var(--accent);
        padding: 16px 20px;
        border-radius: 6px;
        font-size: 15px;
    }
    ul.observaciones {
        padding-left: 20px;
    }
    ul.observaciones li {
        margin-bottom: 8px;
    }
    .reco {
        background: #ecfdf5;
        border-left: 4px solid var(--good);
        padding: 14px 18px;
        border-radius: 6px;
        margin-bottom: 12px;
    }
    .reco-title {
        font-weight: 700;
        margin-bottom: 4px;
        color: #065f46;
    }
    .reco-detalle {
        font-size: 14px;
        margin-bottom: 6px;
    }
    .reco-impacto {
        font-size: 13px;
        color: var(--muted);
    }
    table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
    }
    th, td {
        text-align: left;
        padding: 8px 10px;
        border-bottom: 1px solid var(--border);
    }
    th {
        background: #f1f5f9;
        font-weight: 600;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.3px;
        color: var(--muted);
    }
    td.num, th.num { text-align: right; }
    .alertas .alerta {
        padding: 10px 14px;
        border-radius: 6px;
        margin-bottom: 8px;
        font-size: 14px;
    }
    .alerta-warning  { background: #fef9c3; border-left: 4px solid var(--warn); }
    .alerta-critical { background: #fee2e2; border-left: 4px solid var(--bad); }
    .alerta-info     { background: #dbeafe; border-left: 4px solid var(--primary); }
    .footer {
        text-align: center;
        font-size: 12px;
        color: var(--muted);
        margin-top: 32px;
        padding-top: 16px;
        border-top: 1px solid var(--border);
    }
    .empty {
        color: var(--muted);
        font-style: italic;
        font-size: 14px;
    }
    /* P&L cascade */
    .pyg-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 15px;
    }
    .pyg-table td {
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
    }
    .pyg-table td.num {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
    }
    .pyg-table tr.pyg-minus td { color: var(--muted); }
    .pyg-table tr.pyg-subtotal td {
        background: #f1f5f9;
        font-weight: 600;
    }
    .pyg-table tr.pyg-total td {
        background: var(--primary);
        color: white;
        font-size: 17px;
        border-bottom: none;
    }
    .pyg-table tr.pyg-total td.num strong { color: #fff; }
    .pyg-table tr.pyg-total .kpi-good { color: #86efac; }
    .pyg-table tr.pyg-total .kpi-bad { color: #fca5a5; }
    .pyg-table tr.pyg-pct td {
        background: #f8fafc;
        font-size: 13px;
        color: var(--muted);
    }
    .pyg-sub-info {
        color: var(--muted);
        font-weight: 400;
        font-size: 12px;
    }
    /* Mermas KPI */
    .mermas-kpi {
        background: #fef2f2;
        border-left: 4px solid var(--bad);
        padding: 14px 18px;
        border-radius: 6px;
        margin-bottom: 12px;
    }
    .mermas-kpi-label {
        font-size: 12px;
        text-transform: uppercase;
        color: var(--muted);
        margin-bottom: 4px;
    }
    .mermas-kpi-value {
        font-size: 22px;
        font-weight: 700;
    }
    .mermas-kpi-sub {
        font-size: 12px;
        color: var(--muted);
        margin-top: 2px;
    }
    /* Sparkline container */
    .sparkline-box {
        background: #f8fafc;
        border-radius: 8px;
        padding: 12px 16px;
        border: 1px solid var(--border);
    }

    @media print {
        body { background: white; padding: 0; }
        .print-bar { display: none; }
        .report { box-shadow: none; padding: 24px; border-radius: 0; }
        h2 { page-break-after: avoid; }
        table, .reco, .resumen, .alerta, .kpi-card { page-break-inside: avoid; }
    }
</style>
</head>
<body>
<div class="container">
    <div class="print-bar">
        <button class="btn-print" onclick="window.print()">🖨️ ${escapeHtml(T.imprimir)}</button>
    </div>
    <div class="report">
        <header class="cover">
            <h1>${escapeHtml(T.titulo)}</h1>
            <div class="subtitle">${escapeHtml(T.periodo)}: ${escapeHtml(datos.periodo.mes)}</div>
            <div class="restaurante">${escapeHtml(restauranteNombre)}</div>
        </header>

        <section>
            <h2>📊 ${escapeHtml(T.kpis)}</h2>
            <div class="kpi-grid">
                <div class="kpi-card">
                    <div class="kpi-label">${escapeHtml(T.ingresos)}</div>
                    <div class="kpi-value">${fmtMoneda(datos.ingresos.mes_actual, moneda)}</div>
                    <div class="kpi-sub"><span class="${variacionClass}">${variacionIngresos === null ? '—' : fmtVariacion(variacionIngresos)}</span> ${escapeHtml(T.variacionMes)}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-label">${escapeHtml(T.foodCost)}</div>
                    <div class="kpi-value ${fcClass}">${fmtPct(datos.food_cost.mes_actual_pct)}</div>
                    <div class="kpi-sub">${escapeHtml(T.cogs)}: ${fmtMoneda(datos.food_cost.cogs_actual, moneda)}</div>
                    ${datos.food_cost.mermas_valor > 0 ? `
                    <div class="kpi-sub" style="margin-top:6px;border-top:1px dashed var(--border);padding-top:6px;">
                        <span class="${classFoodCost(datos.food_cost.real_pct)}">${escapeHtml(T.foodCostReal)}: ${fmtPct(datos.food_cost.real_pct)}</span>
                        <br><small>${escapeHtml(T.foodCostRealHint)}</small>
                    </div>
                    ` : ''}
                </div>
                <div class="kpi-card">
                    <div class="kpi-label">${escapeHtml(T.stock)}</div>
                    <div class="kpi-value">${fmtMoneda(datos.stock.valor_total, moneda)}</div>
                    <div class="kpi-sub">${datos.stock.items_bajo_minimo || 0} ${escapeHtml(T.bajoMinimo)} · ${datos.stock.items_sin_stock || 0} ${escapeHtml(T.sinStock)}</div>
                </div>
            </div>
        </section>

        <section>
            <h2>📝 ${escapeHtml(T.resumen)}</h2>
            <div class="resumen">${mdToHtml(analisis.resumen_ejecutivo || '')}</div>
        </section>

        <section>
            <h2>💼 ${escapeHtml(T.pyg)}</h2>
            ${pygHtml}
        </section>

        ${sparklineHtml ? `
        <section>
            <h2>📉 ${escapeHtml(T.evolucion)}</h2>
            <div class="sparkline-box">${sparklineHtml}</div>
        </section>
        ` : ''}

        ${observacionesHtml ? `
        <section>
            <h2>🔍 ${escapeHtml(T.observaciones)}</h2>
            <ul class="observaciones">${observacionesHtml}</ul>
        </section>
        ` : ''}

        ${alertasHtml}

        ${recomendacionesHtml ? `
        <section>
            <h2>💡 ${escapeHtml(T.recomendaciones)}</h2>
            ${recomendacionesHtml}
        </section>
        ` : ''}

        ${topProveedoresRows ? `
        <section>
            <h2>🚚 ${escapeHtml(T.topProveedores)}</h2>
            <table>
                <thead>
                    <tr>
                        <th>${escapeHtml(T.proveedor)}</th>
                        <th class="num">${escapeHtml(T.gastoMes)}</th>
                        <th class="num">${escapeHtml(T.gastoAnterior)}</th>
                        <th class="num">${escapeHtml(T.variacion)}</th>
                    </tr>
                </thead>
                <tbody>${topProveedoresRows}</tbody>
            </table>
        </section>
        ` : ''}

        <section>
            <h2>🗑️ ${escapeHtml(T.mermas)}</h2>
            ${mermasHtml}
        </section>

        ${topRentablesRows ? `
        <section>
            <h2>🏆 ${escapeHtml(T.topRentables)}</h2>
            <table>
                <thead>
                    <tr>
                        <th>${escapeHtml(T.plato)}</th>
                        <th class="num">${escapeHtml(T.vendidas)}</th>
                        <th class="num">${escapeHtml(T.ingresos)}</th>
                        <th class="num">${escapeHtml(T.margen)}</th>
                    </tr>
                </thead>
                <tbody>${topRentablesRows}</tbody>
            </table>
        </section>
        ` : ''}

        ${topProblematicosRows ? `
        <section>
            <h2>⚠️ ${escapeHtml(T.topProblematicos)}</h2>
            <table>
                <thead>
                    <tr>
                        <th>${escapeHtml(T.plato)}</th>
                        <th class="num">${escapeHtml(T.vendidas)}</th>
                        <th class="num">${escapeHtml(T.foodCost)}</th>
                    </tr>
                </thead>
                <tbody>${topProblematicosRows}</tbody>
            </table>
        </section>
        ` : ''}

        ${cambiosPrecioRows ? `
        <section>
            <h2>📈 ${escapeHtml(T.cambiosPrecio)}</h2>
            <table>
                <thead>
                    <tr>
                        <th>${escapeHtml(T.ingrediente)}</th>
                        <th class="num">${escapeHtml(T.precioAnterior)}</th>
                        <th class="num">${escapeHtml(T.precioActual)}</th>
                        <th class="num">${escapeHtml(T.variacion)}</th>
                    </tr>
                </thead>
                <tbody>${cambiosPrecioRows}</tbody>
            </table>
        </section>
        ` : ''}

        <div class="footer">
            ${escapeHtml(T.generadoEl)} ${escapeHtml(fechaGen)} · MindLoop CostOS
        </div>
    </div>
</div>
</body>
</html>`;
}

async function generarInformeHtml({ datos, restauranteNombre, moneda, lang }) {
    const { analisis, usage } = await pedirAnalisisIA({ datos, restauranteNombre, moneda, lang });
    const html = renderHtml({ datos, analisis, restauranteNombre, moneda, lang });
    return { html, usage };
}

module.exports = {
    generarInformeHtml,
    // Solo para tests unitarios — exponemos los helpers internos para
    // poder verificar escapeHtml (anti-XSS), formato multi-currency,
    // sparkline edge cases, etc. sin necesidad de mockear Claude.
    _internals: {
        escapeHtml,
        fmtMoneda,
        fmtPct,
        fmtVariacion,
        classFoodCost,
        mdToHtml,
        renderSparkline,
        renderHtml
    }
};
