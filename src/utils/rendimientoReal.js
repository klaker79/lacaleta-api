/**
 * Rendimiento real de una elaboración: pesas lo que entra crudo (bruta) y lo
 * que sale utilizable (neta) y el rendimiento es neta/bruta en %.
 *
 * Puede superar el 100% (arroz, legumbre seca, hidratados): el tope de 500%
 * solo caza dedazos (pesar en g la bruta y en kg la neta, o al revés).
 */

const RENDIMIENTO_MAX = 500;

function calcularRendimientoReal(cantidadBruta, cantidadNeta) {
    const bruta = parseFloat(cantidadBruta);
    const neta = parseFloat(cantidadNeta);

    if (!Number.isFinite(bruta) || bruta <= 0) {
        return { valid: false, error: 'cantidadBruta debe ser un número positivo' };
    }
    if (!Number.isFinite(neta) || neta <= 0) {
        return { valid: false, error: 'cantidadNeta debe ser un número positivo' };
    }

    const rendimiento = Math.round((neta / bruta) * 100 * 100) / 100;

    if (rendimiento > RENDIMIENTO_MAX) {
        return {
            valid: false,
            error: `Rendimiento ${rendimiento}% imposible (¿unidades distintas en bruta y neta?)`
        };
    }

    return { valid: true, bruta, neta, rendimiento };
}

module.exports = { calcularRendimientoReal, RENDIMIENTO_MAX };
