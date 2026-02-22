-- Migración: Añadir campos de Stripe a restaurantes
-- Fecha: 2026-02-22
-- Propósito: Soporte para suscripciones Stripe (planes, customers, trials)
--
-- SEGURIDAD: Los DEFAULT aseguran que restaurantes existentes NO quedan con NULL
-- Todos los existentes arrancan como 'trial'/'trialing' y luego se overridean abajo
--

-- Campos de Stripe
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'trial';
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS plan_status TEXT DEFAULT 'trialing';
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE restaurantes ADD COLUMN IF NOT EXISTS max_users INTEGER DEFAULT 2;

-- Índice para búsquedas rápidas por Stripe customer
CREATE INDEX IF NOT EXISTS idx_restaurantes_stripe_customer ON restaurantes(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- CRÍTICO: Todos los restaurantes existentes en producción → premium/active
-- Esto incluye La Nave 5 (el restaurante activo en producción)
-- Usamos UPDATE sin WHERE para cubrir TODOS los existentes (ahora mismo solo hay 1)
-- Futuros restaurantes entrarán como 'trial' por el DEFAULT
UPDATE restaurantes SET plan = 'premium', plan_status = 'active', max_users = 999
WHERE plan = 'trial';  -- Solo afecta a los que acaban de recibir el DEFAULT
