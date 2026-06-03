/**
 * onboardingService.js
 *
 * Track onboarding progress per tenant. Stores a timestamp (first creation)
 * for each of the 4 critical steps and a global completion timestamp.
 *
 * Pasos: proveedores -> ingredientes -> recetas -> pedidos.
 *
 * Diseño:
 * - Es idempotente: si la columna ya está seteada, no se sobrescribe.
 * - Es no-bloqueante: los hooks llaman a markStep dentro de un try/catch
 *   que NO debe romper el flujo principal (crear ingrediente, etc).
 * - Una vez `onboarding_completado_at` se setea, no se desmarca jamás
 *   (decisión Iker 2026-06-03: si el cliente borra todo, el checklist
 *   no reaparece).
 *
 * Las queries usan `WHERE id = $1` (NOT restaurante_id porque restaurantes
 * es la propia tabla de tenants).
 */

const { log } = require('../utils/logger');

const STEP_COLUMNS = {
    proveedores: 'onboarding_proveedores_at',
    ingredientes: 'onboarding_ingredientes_at',
    recetas: 'onboarding_recetas_at',
    pedidos: 'onboarding_pedidos_at'
};

/**
 * Marca un paso del onboarding como completado para el tenant.
 * No-op si la columna ya tenía valor.
 *
 * @param {Pool} pool - conexión PostgreSQL
 * @param {number} restauranteId
 * @param {'proveedores'|'ingredientes'|'recetas'|'pedidos'} step
 * @returns {Promise<void>}
 */
async function markStep(pool, restauranteId, step) {
    const column = STEP_COLUMNS[step];
    if (!column) {
        log('warn', `[onboarding] paso desconocido: ${step}`);
        return;
    }
    if (!restauranteId) {
        log('warn', `[onboarding] markStep sin restauranteId (paso=${step})`);
        return;
    }

    try {
        // 1) Marca el paso si era NULL.
        await pool.query(
            `UPDATE restaurantes
               SET ${column} = COALESCE(${column}, NOW())
             WHERE id = $1`,
            [restauranteId]
        );

        // 2) Si los 4 pasos están seteados, marca completado (idempotente).
        await pool.query(
            `UPDATE restaurantes SET
               onboarding_completado_at = COALESCE(onboarding_completado_at, NOW())
             WHERE id = $1
               AND onboarding_proveedores_at IS NOT NULL
               AND onboarding_ingredientes_at IS NOT NULL
               AND onboarding_recetas_at IS NOT NULL
               AND onboarding_pedidos_at IS NOT NULL`,
            [restauranteId]
        );
    } catch (err) {
        // No propagamos: el flujo principal (crear ingrediente, etc) NO debe romperse.
        log('error', `[onboarding] markStep(${step}) falló para tenant ${restauranteId}: ${err.message}`);
    }
}

/**
 * Devuelve el estado actual del onboarding para un tenant.
 *
 * @param {Pool} pool
 * @param {number} restauranteId
 * @returns {Promise<{pasos: Array<{key: string, completed_at: string|null}>, completado: boolean, completado_at: string|null}>}
 */
async function getStatus(pool, restauranteId) {
    const result = await pool.query(
        `SELECT
           onboarding_proveedores_at,
           onboarding_ingredientes_at,
           onboarding_recetas_at,
           onboarding_pedidos_at,
           onboarding_completado_at
         FROM restaurantes
         WHERE id = $1`,
        [restauranteId]
    );

    const row = result.rows[0] || {};
    const pasos = [
        { key: 'proveedores', completed_at: row.onboarding_proveedores_at || null },
        { key: 'ingredientes', completed_at: row.onboarding_ingredientes_at || null },
        { key: 'recetas', completed_at: row.onboarding_recetas_at || null },
        { key: 'pedidos', completed_at: row.onboarding_pedidos_at || null }
    ];
    return {
        pasos,
        completado: !!row.onboarding_completado_at,
        completado_at: row.onboarding_completado_at || null
    };
}

module.exports = {
    markStep,
    getStatus,
    STEP_COLUMNS
};
