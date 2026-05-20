/**
 * Polar.sh service — Merchant of Record para el add-on Chat IA.
 *
 * Polar es la pasarela de pago + emisor legal de facturas. Nuestro backend
 * NUNCA toca chat_addon directamente: el flag se cambia solo desde el
 * webhook firmado por Polar.
 *
 * Funciones expuestas:
 *   - createCheckoutSession(restauranteId, productId, origin) → URL para
 *     redirigir al cliente.
 *   - createCustomerPortalSession(restauranteId) → URL del portal Polar
 *     donde el cliente puede cancelar o gestionar la sub.
 *   - verifyWebhook(rawBody, headers) → valida firma y devuelve el evento
 *     parseado, o lanza si la firma no es válida.
 *
 * Init lazy: el SDK solo se construye cuando alguien llama una función,
 * así si POLAR_API_KEY no está seteada en el env (ej. desarrollo local sin
 * Polar) la app arranca igual y el endpoint devuelve 500 cuando se llame.
 */

const { Polar } = require('@polar-sh/sdk');
const { Webhook } = require('standardwebhooks');
const { log } = require('../utils/logger');

let _polar = null;
let _webhook = null;

function getPolar() {
    if (_polar) return _polar;
    const key = process.env.POLAR_API_KEY;
    if (!key) throw new Error('POLAR_API_KEY no configurada');
    _polar = new Polar({
        accessToken: key,
        // sandbox o production según env. Default sandbox para no cobrar
        // accidentalmente en staging.
        server: process.env.POLAR_ENV === 'production' ? 'production' : 'sandbox'
    });
    return _polar;
}

function getWebhookValidator() {
    if (_webhook) return _webhook;
    const secret = process.env.POLAR_WEBHOOK_SECRET;
    if (!secret) throw new Error('POLAR_WEBHOOK_SECRET no configurada');
    // standardwebhooks espera el secret en base64. Polar lo entrega ya en ese formato.
    _webhook = new Webhook(secret);
    return _webhook;
}

/**
 * Crea checkout session en Polar para que el cliente pague una suscripción.
 * El cliente vuelve a `origin` con ?addon=success o ?subscription=success
 * según el tipo de producto.
 *
 * Importante: pasamos restauranteId en metadata Y como external_customer_id
 *   - metadata: el webhook lee subscription.metadata.restaurante_id +
 *     addon_type para ramificar el handler
 *   - external_customer_id: si el mismo restaurante vuelve a comprar, Polar
 *     reusa el mismo customer (no duplica)
 *
 * @param {object} params
 * @param {number} params.restauranteId
 * @param {string} params.productId — UUID del producto en Polar
 * @param {string} params.origin — URL de origen para el success redirect
 * @param {('chat_ia'|'base')} [params.addonType='chat_ia'] — discriminador
 *   para que el webhook handler sepa qué flujo aplicar.
 */
async function createCheckoutSession({ restauranteId, productId, origin, addonType = 'chat_ia' }) {
    const polar = getPolar();
    // Discriminamos el query param de retorno para que el frontend pueda
    // mostrar mensajes y refrescar el estado correcto.
    const successParam = addonType === 'base' ? 'subscription=success' : 'addon=success';
    const successUrl = `${origin}/?${successParam}`;

    const checkout = await polar.checkouts.create({
        products: [productId],
        successUrl,
        externalCustomerId: `restaurante_${restauranteId}`,
        metadata: {
            restaurante_id: String(restauranteId),
            addon_type: addonType
        }
    });

    return { url: checkout.url, id: checkout.id };
}

/**
 * Devuelve URL del Customer Portal de Polar para que el cliente cancele
 * o cambie tarjeta. Se basa en customer-session: Polar emite un token
 * temporal que da acceso al portal sin login.
 */
async function createCustomerPortalSession({ restauranteId }) {
    const polar = getPolar();
    const session = await polar.customerSessions.create({
        externalCustomerId: `restaurante_${restauranteId}`
    });
    return { url: session.customerPortalUrl };
}

/**
 * Verifica firma del webhook con standardwebhooks. Lanza si la firma
 * no es válida (cuerpo manipulado o secret incorrecto).
 *
 * @param {Buffer} rawBody — body crudo, NO parseado
 * @param {object} headers — headers HTTP del request
 * @returns {object} evento parseado: { type, data }
 */
function verifyWebhook(rawBody, headers) {
    const validator = getWebhookValidator();
    // standardwebhooks espera el body como string
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
    // Throws on invalid signature
    const event = validator.verify(bodyStr, {
        'webhook-id': headers['webhook-id'],
        'webhook-timestamp': headers['webhook-timestamp'],
        'webhook-signature': headers['webhook-signature']
    });
    return event; // { type, data, ... }
}

module.exports = {
    createCheckoutSession,
    createCustomerPortalSession,
    verifyWebhook,
    // Solo para tests:
    _resetClients: () => { _polar = null; _webhook = null; }
};
