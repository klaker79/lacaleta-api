/**
 * omnesCalculator.js
 *
 * Funciones puras para calcular los Principios de Omnes a partir de
 * una lista de platos. Aisladas del endpoint para poder testearse sin DB.
 *
 * Cada plato esperado:
 *   { id, nombre, precio_venta: number, cantidad_vendida: number }
 *
 * Las 3 funciones nunca lanzan: ante datos insuficientes devuelven
 * estado 'sin_datos' o 'sin_ventas' con valores null.
 */

const PRECIO_MIN_VALIDO = 0.01;

function platosValidos(platos) {
    if (!Array.isArray(platos)) return [];
    return platos.filter(p =>
        p && Number.isFinite(p.precio_venta) && p.precio_venta > PRECIO_MIN_VALIDO
    );
}

/**
 * Calcula la mediana de una lista de números. Robusta ante outliers
 * (al contrario que la media, no se desplaza por valores extremos).
 */
function mediana(numeros) {
    if (numeros.length === 0) return 0;
    const sorted = [...numeros].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

/**
 * 1. Dispersión = precio_max / precio_min.
 * Ideal ≤ 2.5.
 *
 * Filtrado automático de outliers (sin configuración del cliente):
 *   Calculamos la mediana de precios y descartamos los platos que caen
 *   fuera del rango [mediana / 2.5, mediana × 2.5]. El factor 2.5 está
 *   alineado con el propio ideal de Omnes (dispersión ≤ 2.5×): lo que
 *   por sí solo ya rompe el rango ideal no se considera parte de la
 *   carta cotidiana.
 *
 *   Es una variante del método MAD (Median Absolute Deviation), estándar
 *   estadístico para detectar outliers en muestras pequeñas o sesgadas.
 *
 *   Casos típicos que filtra automáticamente:
 *     - PAN POR PERSONA / CUBIERTO / SUPLEMENTOS (cargos automáticos)
 *     - OSTRAS o MARISCO POR UNIDAD (no son platos completos)
 *     - BOGAVANTE / PRODUCTOS DE OFERTA PUNTUAL (precio extremo no habitual)
 *     - Menús degustación atípicos
 *
 *   El campo `filtro_outliers_aplicado` permite al frontend avisar al
 *   cliente cuando se ha recortado.
 *
 * Salvaguarda: si el filtro deja < 2 platos (caso patológico), se usan
 * todos los platos originales para no devolver 'sin_datos' artificial.
 */
const OUTLIER_RATIO = 2.5;

function calcularDispersion(platos) {
    const ps = platosValidos(platos);
    if (ps.length === 0) {
        return {
            valor: null, estado: 'sin_datos',
            precio_max: null, precio_min: null,
            plato_max: null, plato_min: null,
            filtro_outliers_aplicado: false,
            platos_excluidos: 0, total_platos: 0
        };
    }

    const med = mediana(ps.map(p => p.precio_venta));
    const minRango = med / OUTLIER_RATIO;
    const maxRango = med * OUTLIER_RATIO;
    const enRango = ps.filter(p => p.precio_venta >= minRango && p.precio_venta <= maxRango);

    // Salvaguarda: si el filtro deja <2 platos (caso patológico), usar todos
    const usados = enRango.length >= 2 ? enRango : ps;
    const filtroAplicado = usados.length < ps.length;

    const ordenados = [...usados].sort((a, b) => a.precio_venta - b.precio_venta);
    const min = ordenados[0];
    const max = ordenados[ordenados.length - 1];
    const valor = max.precio_venta / min.precio_venta;
    let estado;
    if (valor <= 2.5) estado = 'ok';
    else if (valor <= 3.5) estado = 'alta';
    else estado = 'muy_alta';
    return {
        valor: Math.round(valor * 100) / 100,
        estado,
        precio_max: max.precio_venta,
        precio_min: min.precio_venta,
        plato_max: max.nombre,
        plato_min: min.nombre,
        filtro_outliers_aplicado: filtroAplicado,
        platos_excluidos: ps.length - usados.length,
        total_platos: ps.length
    };
}

/**
 * 2. Amplitud de gama = distribución % entre baja/media/alta.
 * Ideal 25/50/25. Desviación = |Δbaja|+|Δmedia|+|Δalta|.
 */
function calcularAmplitud(platos) {
    const ps = platosValidos(platos);
    const total = ps.length;
    if (total <= 1) {
        return { baja_pct: null, media_pct: null, alta_pct: null, estado: 'sin_datos', desviacion: null, total_platos: total };
    }
    const precioMedio = ps.reduce((s, p) => s + p.precio_venta, 0) / total;
    const umbralBaja = precioMedio * 0.75;
    const umbralAlta = precioMedio * 1.25;
    const baja = ps.filter(p => p.precio_venta < umbralBaja).length;
    const alta = ps.filter(p => p.precio_venta > umbralAlta).length;
    const media = total - baja - alta;
    const bajaPct = Math.round((baja / total) * 100);
    const mediaPct = Math.round((media / total) * 100);
    const altaPct = 100 - bajaPct - mediaPct; // garantiza suma 100
    const desviacion = Math.abs(bajaPct - 25) + Math.abs(mediaPct - 50) + Math.abs(altaPct - 25);
    let estado;
    if (desviacion < 15) estado = 'equilibrada';
    else if (desviacion <= 30) estado = 'desbalance';
    else estado = 'muy_desbalanceada';
    return {
        baja_pct: bajaPct,
        media_pct: mediaPct,
        alta_pct: altaPct,
        estado,
        desviacion,
        total_platos: total
    };
}

/**
 * 3. Relación calidad-precio = precio_medio_vendido / precio_medio_ofertado.
 * Ideal 0.95-1.05.
 */
function calcularCalidadPrecio(platos) {
    const ps = platosValidos(platos);
    const total = ps.length;
    const totalUnidades = ps.reduce((s, p) => s + (p.cantidad_vendida || 0), 0);
    if (total === 0) {
        return { ratio: null, estado: 'sin_datos', ofertado: null, vendido: null, unidades_vendidas: 0 };
    }
    const ofertado = ps.reduce((s, p) => s + p.precio_venta, 0) / total;
    if (totalUnidades === 0) {
        return { ratio: null, estado: 'sin_ventas', ofertado: Math.round(ofertado * 100) / 100, vendido: null, unidades_vendidas: 0 };
    }
    const totalIngresos = ps.reduce((s, p) => s + p.precio_venta * (p.cantidad_vendida || 0), 0);
    const vendido = totalIngresos / totalUnidades;
    const ratio = vendido / ofertado;
    let estado;
    if (ratio >= 0.95 && ratio <= 1.05) estado = 'equilibrado';
    else if (ratio < 0.95) estado = 'bajan';
    else estado = 'suben';
    return {
        ratio: Math.round(ratio * 100) / 100,
        estado,
        ofertado: Math.round(ofertado * 100) / 100,
        vendido: Math.round(vendido * 100) / 100,
        unidades_vendidas: Math.round(totalUnidades)
    };
}

/**
 * Genera la frase de recomendación global combinando los 3 estados.
 * Máximo 3 frases, ordenadas por severidad implícita.
 */
function generarRecomendacionGlobal({ dispersion, amplitud, calidad_precio }) {
    const frases = [];
    if (dispersion.estado === 'muy_alta') {
        frases.push('Reduce mucho la dispersión: quita platos de los extremos de precio.');
    } else if (dispersion.estado === 'alta') {
        frases.push('Reduce dispersión: quita 2-3 platos de los extremos de precio.');
    }
    if (amplitud.estado === 'muy_desbalanceada') {
        frases.push('Reequilibra la distribución: apunta a 25/50/25 (baja/media/alta).');
    } else if (amplitud.estado === 'desbalance') {
        frases.push('Reequilibra suavemente la distribución de gamas.');
    }
    if (calidad_precio.estado === 'bajan') {
        frases.push('Los clientes piden los platos más baratos: sube precios medios un 5-7%.');
    } else if (calidad_precio.estado === 'suben') {
        frases.push('Los clientes piden los platos más caros: introduce más opciones de gama media.');
    }
    if (frases.length === 0) {
        frases.push('Tu carta está bien equilibrada. Mantén la estrategia.');
    }
    return frases.slice(0, 3).join(' ');
}

module.exports = {
    calcularDispersion,
    calcularAmplitud,
    calcularCalidadPrecio,
    generarRecomendacionGlobal
};
