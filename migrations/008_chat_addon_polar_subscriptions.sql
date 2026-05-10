-- Migration 008: Polar subscriptions tracking para Chat IA add-on
--
-- Contexto: el flag chat_addon en restaurantes (migration 007) lo controlará
-- el webhook de Polar. Esta tabla guarda el histórico de eventos para
-- auditoría — saber qué subscription_id activó/desactivó qué tenant y cuándo.
--
-- No reemplaza el flag (sigue en restaurantes.chat_addon para gating O(1));
-- complementa con trazabilidad cuando un cliente reclame "yo no me suscribí"
-- o haya una disputa de pago.
--
-- Diseño:
--   - polar_subscription_id: UNIQUE, así no procesamos dos veces el mismo evento
--   - status: copia el status de Polar (active, canceled, revoked, etc.)
--   - raw_event: JSONB del evento original por si hace falta inspeccionar campos
--     que aún no usamos (current_period_end, customer_id, prices, etc.)
--
-- IMPORTANTE: idempotente con IF NOT EXISTS

CREATE TABLE IF NOT EXISTS chat_addon_subscriptions (
    id SERIAL PRIMARY KEY,
    restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE,
    polar_subscription_id TEXT UNIQUE NOT NULL,
    polar_customer_id TEXT,
    status TEXT NOT NULL,
    current_period_end TIMESTAMPTZ,
    raw_event JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_addon_subs_restaurante
    ON chat_addon_subscriptions (restaurante_id);

CREATE INDEX IF NOT EXISTS idx_chat_addon_subs_status
    ON chat_addon_subscriptions (status);

COMMENT ON TABLE chat_addon_subscriptions IS
    'Auditoría de subscripciones del add-on Chat IA en Polar. El flag de acceso vive en restaurantes.chat_addon.';
COMMENT ON COLUMN chat_addon_subscriptions.polar_subscription_id IS
    'sub_xxx de Polar. UNIQUE para idempotencia de webhooks.';
COMMENT ON COLUMN chat_addon_subscriptions.raw_event IS
    'Último evento de Polar (JSONB). Útil para depurar campos no normalizados.';
