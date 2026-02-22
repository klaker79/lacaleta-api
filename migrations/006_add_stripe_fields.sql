-- Migración: Añadir campos de Stripe a restaurantes
-- Fecha: 2026-02-22
-- Propósito: Soporte para suscripciones Stripe (planes, customers, trials)

-- Campos de Stripe
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'trial';
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS plan_status TEXT DEFAULT 'trialing';
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS max_users INTEGER DEFAULT 2;

-- Índice para búsquedas rápidas por Stripe customer
CREATE INDEX IF NOT EXISTS idx_restaurantes_stripe_customer ON restaurantes(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- La Caleta 102 (restaurante existente) → premium gratis, sin límite de usuarios
UPDATE restaurantes SET plan = 'premium', plan_status = 'active', max_users = 999 WHERE id = 1;
