/**
 * Reglas de jornada de hostelería — turno seguido y turno PARTIDO.
 *
 * En un restaurante el partido es la norma (ej. 12:00-16:00 y 20:00-00:00), y
 * los turnos cruzan medianoche constantemente. Estas funciones son puras y las
 * comparte todo el backend: rutas de horarios, validaciones y cálculo de horas.
 *
 * Convenios:
 * - Las horas son strings 'HH:MM' (validadas con validateHora).
 * - Si `fin <= inicio`, el tramo cruza medianoche y termina al día siguiente.
 *   20:00-00:00 son 4h; 22:00-02:00 son 4h. Un tramo de 0 minutos no existe:
 *   00:00-00:00 se interpreta como 24h, que ya rechaza el límite de jornada.
 */

const MINUTOS_DIA = 1440;

/** Descanso mínimo entre el fin de una jornada y el inicio de la siguiente. */
const DESCANSO_ENTRE_JORNADAS_H = 12;

/** Tope de horas de un tramo suelto (un turno de más de 12h no es real). */
const MAX_HORAS_TRAMO = 12;

/** Tope de horas sumadas en un mismo día. */
const MAX_HORAS_DIA = 12;

/** Convierte 'HH:MM' (o 'HH:MM:SS') a minutos desde medianoche. */
function aMinutos(hora) {
    const m = String(hora ?? '').trim().match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}

/** Minutos desde medianoche → 'HH:MM'. */
function aHora(minutos) {
    const t = ((minutos % MINUTOS_DIA) + MINUTOS_DIA) % MINUTOS_DIA;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * Duración de un tramo en minutos, contando el cruce de medianoche.
 * @returns {number|null} null si alguna hora es inválida
 */
function duracionTramoMin(inicio, fin) {
    const ini = aMinutos(inicio);
    const f = aMinutos(fin);
    if (ini === null || f === null) return null;
    // fin <= inicio ⇒ termina al día siguiente (20:00→00:00, 22:00→02:00)
    return f > ini ? f - ini : f + MINUTOS_DIA - ini;
}

/** Duración en horas (decimal) de un tramo. */
function duracionTramoHoras(inicio, fin) {
    const min = duracionTramoMin(inicio, fin);
    return min === null ? null : min / 60;
}

/**
 * Suma las horas de una lista de tramos [{hora_inicio, hora_fin}].
 * Ignora los tramos con horas inválidas o incompletas.
 */
function horasDeTramos(tramos) {
    return (tramos || []).reduce((total, t) => {
        const h = duracionTramoHoras(t.hora_inicio, t.hora_fin);
        return total + (h === null ? 0 : h);
    }, 0);
}

/**
 * ¿Se solapan dos tramos del MISMO día?
 *
 * Trabaja en la línea temporal absoluta desde el inicio del día, así que
 * detecta bien los casos con cruce de medianoche (un tramo 22:00-02:00 no
 * solapa con uno 09:00-14:00 del mismo día: el segundo va antes).
 */
function tramosSolapan(a, b) {
    const iniA = aMinutos(a.hora_inicio);
    const iniB = aMinutos(b.hora_inicio);
    const durA = duracionTramoMin(a.hora_inicio, a.hora_fin);
    const durB = duracionTramoMin(b.hora_inicio, b.hora_fin);
    if (iniA === null || iniB === null || durA === null || durB === null) return false;
    return iniA < iniB + durB && iniB < iniA + durA;
}

/**
 * Valida los tramos de un mismo día.
 * @returns {{ valid: boolean, error?: string, horas?: number }}
 */
function validarDia(tramos) {
    const lista = (tramos || []).filter(t => t && t.hora_inicio && t.hora_fin);
    if (lista.length === 0) return { valid: true, horas: 0 };
    if (lista.length > 2) {
        return { valid: false, error: 'Un día admite como máximo 2 tramos (turno partido)' };
    }

    for (const t of lista) {
        const horas = duracionTramoHoras(t.hora_inicio, t.hora_fin);
        if (horas === null) return { valid: false, error: 'Horas de tramo inválidas' };
        if (horas > MAX_HORAS_TRAMO) {
            return { valid: false, error: `Un tramo no puede pasar de ${MAX_HORAS_TRAMO}h` };
        }
    }

    if (lista.length === 2 && tramosSolapan(lista[0], lista[1])) {
        return { valid: false, error: 'Los dos tramos del día se solapan' };
    }

    const horas = horasDeTramos(lista);
    if (horas > MAX_HORAS_DIA) {
        return { valid: false, error: `La jornada del día no puede pasar de ${MAX_HORAS_DIA}h` };
    }

    return { valid: true, horas };
}

/**
 * Comprueba el descanso legal entre el último tramo de un día y el primero del
 * día siguiente (12h de mínimo, art. 34.3 ET).
 *
 * Es el fallo típico del turno partido: cerrar a las 00:00 y entrar a las 09:00
 * son 9 horas de descanso, no 12.
 *
 * @param {{hora_inicio: string, hora_fin: string}[]} tramosDia - tramos del día
 * @param {{hora_inicio: string, hora_fin: string}[]} tramosDiaSiguiente
 * @returns {{ cumple: boolean, horas: number|null, mensaje?: string }}
 */
function comprobarDescansoEntreJornadas(tramosDia, tramosDiaSiguiente) {
    const hoy = (tramosDia || []).filter(t => t && t.hora_inicio && t.hora_fin);
    const manana = (tramosDiaSiguiente || []).filter(t => t && t.hora_inicio && t.hora_fin);
    if (hoy.length === 0 || manana.length === 0) return { cumple: true, horas: null };

    // Fin de la jornada de hoy, en minutos desde el inicio de hoy (puede pasar
    // de 1440 si el último tramo cruza medianoche).
    const finHoy = Math.max(...hoy.map(t => aMinutos(t.hora_inicio) + duracionTramoMin(t.hora_inicio, t.hora_fin)));
    // Inicio de mañana, en la misma escala: +1440 porque es el día siguiente.
    const inicioManana = MINUTOS_DIA + Math.min(...manana.map(t => aMinutos(t.hora_inicio)));

    const horas = (inicioManana - finHoy) / 60;
    if (horas >= DESCANSO_ENTRE_JORNADAS_H) return { cumple: true, horas };

    return {
        cumple: false,
        horas,
        mensaje: `Sólo ${horas.toFixed(1)}h de descanso entre jornadas (mínimo ${DESCANSO_ENTRE_JORNADAS_H}h)`
    };
}

/**
 * Construye los tramos de un día a partir de la plantilla de la ficha del
 * empleado, repartiendo `minutosJornada` entre ellos.
 *
 * - Jornada seguida: un tramo desde tramo1_inicio.
 * - Jornada partida: reparte la mitad en cada tramo, respetando las horas de
 *   inicio de la plantilla. Si la plantilla trae horas de fin, se respetan tal
 *   cual (el chef manda sobre el reparto automático).
 *
 * @returns {{tramo: number, hora_inicio: string, hora_fin: string}[]}
 */
function tramosDesdePlantilla(plantilla, minutosJornada) {
    const p = plantilla || {};
    const partido = p.jornada_tipo === 'partido';
    const inicio1 = aMinutos(p.tramo1_inicio) !== null ? aHora(aMinutos(p.tramo1_inicio)) : '10:00';

    if (!partido) {
        // Si la ficha define el fin, manda la ficha; si no, se reparte el contrato.
        const fin1 = p.tramo1_fin && duracionTramoMin(inicio1, p.tramo1_fin)
            ? aHora(aMinutos(p.tramo1_fin))
            : aHora(aMinutos(inicio1) + minutosJornada);
        return [{ tramo: 1, hora_inicio: inicio1, hora_fin: fin1 }];
    }

    const inicio2 = aMinutos(p.tramo2_inicio) !== null ? aHora(aMinutos(p.tramo2_inicio)) : '20:00';
    const definidos = p.tramo1_fin && p.tramo2_fin;

    if (definidos) {
        return [
            { tramo: 1, hora_inicio: inicio1, hora_fin: aHora(aMinutos(p.tramo1_fin)) },
            { tramo: 2, hora_inicio: inicio2, hora_fin: aHora(aMinutos(p.tramo2_fin)) }
        ];
    }

    // Reparto automático: mitad y mitad, redondeando el primero hacia abajo.
    const mitad = Math.floor(minutosJornada / 2);
    return [
        { tramo: 1, hora_inicio: inicio1, hora_fin: aHora(aMinutos(inicio1) + mitad) },
        { tramo: 2, hora_inicio: inicio2, hora_fin: aHora(aMinutos(inicio2) + (minutosJornada - mitad)) }
    ];
}

module.exports = {
    DESCANSO_ENTRE_JORNADAS_H,
    MAX_HORAS_TRAMO,
    MAX_HORAS_DIA,
    aMinutos,
    aHora,
    duracionTramoMin,
    duracionTramoHoras,
    horasDeTramos,
    tramosSolapan,
    validarDia,
    comprobarDescansoEntreJornadas,
    tramosDesdePlantilla
};
