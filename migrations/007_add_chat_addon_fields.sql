-- Migration 007: Chat IA add-on (single-tier pricing model)
--
-- Contexto: tras simplificar a "1 plan único", el chat con Claude API queda
-- como add-on opcional (+30€/mes) para no inflar el coste base de tokens.
-- Cada tenant tiene un cap mensual (300 consultas) que se resetea cada
-- 30 días desde la última fecha de reset.
--
-- Diseño:
--   - chat_addon: boolean, true cuando el cliente paga el add-on (set por
--     webhook de Stripe al alta/cancelación de suscripción del producto).
--   - chat_consultas_mes: contador atómico que se incrementa en cada
--     POST /chat exitoso. Reset perezoso al detectar fecha caducada.
--   - chat_consultas_reset_at: cuándo se reseteó por última vez. Usar
--     para calcular si toca reset (now > reset_at + 30 days) y para mostrar
--     en UI cuándo vuelve a estar disponible tras agotar cuota.
--
-- IMPORTANTE: idempotente (IF NOT EXISTS) para poder re-ejecutar sin daño.

ALTER TABLE restaurantes
    ADD COLUMN IF NOT EXISTS chat_addon BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE restaurantes
    ADD COLUMN IF NOT EXISTS chat_consultas_mes INTEGER NOT NULL DEFAULT 0;

ALTER TABLE restaurantes
    ADD COLUMN IF NOT EXISTS chat_consultas_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Índice no necesario: la columna se consulta junto con el restaurante (PK)
-- por el middleware en cada petición de chat. Acceso por id es ya O(1).

COMMENT ON COLUMN restaurantes.chat_addon IS
    'Add-on Chat IA activado. Set por webhook Stripe al pagar suscripción del addon.';
COMMENT ON COLUMN restaurantes.chat_consultas_mes IS
    'Contador de consultas del chat en el mes en curso. Reset perezoso vía chat_consultas_reset_at.';
COMMENT ON COLUMN restaurantes.chat_consultas_reset_at IS
    'Timestamp del último reset del contador. Reset al pasar 30 días desde este valor.';
