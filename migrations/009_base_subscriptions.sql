-- Migration 009: Polar subscriptions del plan base (95€/mes)
--
-- Contexto: el modelo de pricing tras 2026-05-10 es:
--   - Plan base MindLoop CostOS: 95€/mes (Polar)
--   - Add-on Chat IA: +30€/mes (Polar, ya integrado en migration 008)
--
-- Esta tabla replica el patrón de `chat_addon_subscriptions` para auditoría
-- de eventos del plan base. El flag funcional para gating O(1) es
-- `restaurantes.plan_status` ('active', 'past_due', 'canceled', 'pending_payment').
--
-- Diseño:
--   - polar_subscription_id: UNIQUE → idempotencia ante reintentos de webhook
--   - status: copia el status de Polar (active, canceled, revoked, past_due, ...)
--   - raw_event: JSONB completo para debug / disputas
--
-- IMPORTANTE: idempotente (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS base_subscriptions (
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

CREATE INDEX IF NOT EXISTS idx_base_subs_restaurante
    ON base_subscriptions (restaurante_id);

CREATE INDEX IF NOT EXISTS idx_base_subs_status
    ON base_subscriptions (status);

COMMENT ON TABLE base_subscriptions IS
    'Auditoría de subscripciones del plan base (95€/mes) en Polar. El gating O(1) vive en restaurantes.plan_status.';
COMMENT ON COLUMN base_subscriptions.polar_subscription_id IS
    'sub_xxx de Polar. UNIQUE para idempotencia de webhooks.';
COMMENT ON COLUMN base_subscriptions.raw_event IS
    'Último evento de Polar (JSONB). Útil para depurar campos no normalizados.';
