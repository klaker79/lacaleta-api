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
 * 1. Dispersión = precio_max / precio_min.
 * Ideal ≤ 2.5.
 *
 * Para cartas con suficientes platos (N ≥ MIN_PLATOS_PERCENTILES) usamos
 * los percentiles p5 y p95 en lugar del mínimo y máximo absolutos. Así
 * recortamos outliers naturalmente: cargos automáticos (PAN POR PERSONA,
 * CUBIERTO) en el extremo bajo y platos puntuales (BOGAVANTE de oferta,
 * MARISCO especial) en el extremo alto dejan de inflar artificialmente
 * el ratio. Es el estándar estadístico para análisis de carta.
 *
 * Si la carta es pequeña (N < MIN_PLATOS_PERCENTILES) los percentiles
 * caerían sobre los mismos extremos, así que mantenemos min/max para
 * no introducir ruido.
 *
 * El campo `usa_percentiles` permite al frontend / chat avisar al cliente
 * de que el cálculo ignoró los outliers.
 */
const MIN_PLATOS_PERCENTILES = 10;

function calcularDispersion(platos) {
    const ps = platosValidos(platos);
    if (ps.length === 0) {
        return {
            valor: null, estado: 'sin_datos',
            precio_max: null, precio_min: null,
            plato_max: null, plato_min: null,
            usa_percentiles: false, total_platos: 0
        };
    }
    const ordenados = [...ps].sort((a, b) => a.precio_venta - b.precio_venta);
    const n = ordenados.length;

    let idxMin, idxMax, usaPercentiles;
    if (n >= MIN_PLATOS_PERCENTILES) {
        // p5: floor(N * 0.05). N=44 → 2 (ignoramos 2 más baratos).
        // p95: ceil(N * 0.95) - 1. N=44 → 41 (ignoramos 2 más caros).
        idxMin = Math.floor(n * 0.05);
        idxMax = Math.max(idxMin, Math.ceil(n * 0.95) - 1);
        usaPercentiles = true;
    } else {
        idxMin = 0;
        idxMax = n - 1;
        usaPercentiles = false;
    }

    const min = ordenados[idxMin];
    const max = ordenados[idxMax];
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
        usa_percentiles: usaPercentiles,
        total_platos: n
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
