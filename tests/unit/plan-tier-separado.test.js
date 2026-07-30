/**
 * Guardián: el paquete de pestañas (`plan_tier`) va separado del plan de
 * facturación (`plan`).
 *
 * Bug que cierra (2026-07-30): la columna `plan` hacía los dos trabajos. Como
 * `requireActiveSubscription` deja pasar si (1) `plan_status='active'` o
 * (2) `plan='trial'` con trial vigente, marcar a un cliente como Lite
 * (`plan='lite'`) le rompía la regla 2 y lo dejaba bloqueado con
 * `SUBSCRIPTION_REQUIRED / no_subscription`. Había que ponerle
 * `plan_status='active'` a mano — tratarlo como si ya pagara. Vender Lite con
 * periodo de prueba era imposible.
 *
 * Estos tests fijan las dos mitades del contrato: que el gate sigue mirando
 * SOLO la facturación, y que `plan_tier` llega hasta el cliente.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const GATE = path.join(SRC, 'middleware', 'requireActiveSubscription.js');
const STRIPE = path.join(SRC, 'routes', 'stripe.routes.js');
const INIT = path.join(SRC, 'db', 'init.js');

const gate = fs.readFileSync(GATE, 'utf8');
const stripe = fs.readFileSync(STRIPE, 'utf8');
const init = fs.readFileSync(INIT, 'utf8');

/** Quita comentarios: dentro sí puede citarse un nombre al explicar el porqué. */
function sinComentarios(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('plan_tier separado del plan de facturación', () => {
    test('init.js crea la columna plan_tier', () => {
        expect(init).toMatch(/ADD COLUMN IF NOT EXISTS plan_tier/);
    });

    test('el backfill NO toca plan ni plan_status', () => {
        // Copiar el tier es seguro; reescribir la facturación de un cliente vivo no.
        const bloque = init.slice(init.indexOf('ADD COLUMN IF NOT EXISTS plan_tier'),
            init.indexOf('idx_restaurantes_plan_tier'));
        expect(bloque).toMatch(/SET plan_tier =/);
        expect(bloque).not.toMatch(/SET\s+plan\s*=/);
        expect(bloque).not.toMatch(/plan_status\s*=/);
    });

    test('el backfill solo rellena lo que está vacío', () => {
        expect(init).toMatch(/WHERE plan_tier IS NULL/);
    });

    test('el gate de suscripción NO mira plan_tier: es solo facturación', () => {
        // Si el gate empezara a mirar el tier, volveríamos al problema original.
        expect(sinComentarios(gate)).not.toContain('plan_tier');
    });

    test('el gate sigue aceptando trial vigente y suscripción activa', () => {
        const g = sinComentarios(gate);
        expect(g).toMatch(/plan_status === 'active'/);
        expect(g).toMatch(/plan === 'trial'/);
        expect(g).toMatch(/trial_ends_at/);
    });

    test('subscription-status devuelve plan_tier al cliente', () => {
        expect(stripe).toMatch(/SELECT plan, plan_tier,/);
        expect(sinComentarios(stripe)).toMatch(/plan_tier:\s*row\.plan_tier/);
    });
});
