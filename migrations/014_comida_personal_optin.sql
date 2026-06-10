-- Migración 014: opt-in de "comida de personal" por restaurante.
-- Apagado por defecto. La función (casilla en pedidos + pestaña Comida Personal)
-- solo aparece para los restaurantes que la activen en Configuración.
-- También se aplica vía src/db/init.js en cada arranque (idempotente).

ALTER TABLE restaurantes
    ADD COLUMN IF NOT EXISTS comida_personal_activa BOOLEAN NOT NULL DEFAULT FALSE;
