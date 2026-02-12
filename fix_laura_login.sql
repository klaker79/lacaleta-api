-- 1. Asegurar que el Restaurante 3 existe (La Nave 5)
-- Si no existe, lo crea. Si existe, no hace nada gracias a ON CONFLICT
INSERT INTO restaurantes (id, nombre, email, created_at)
VALUES (3, 'La Nave 5', 'info@lanave5.com', NOW())
ON CONFLICT (id) DO NOTHING;

-- 2. Reparar usuario 'laura@lanave5'
-- Borramos el usuario existente para evitar conflictos de ID o estado corrupto
DELETE FROM usuarios WHERE email = 'laura@lanave5';

-- Insertamos el usuario con contraseña 'laura' (hash generado: $2a$10$aZemRdOtz3zTnkj4mTtHpOBgIbfCnGTPx44.GWqwaKlLq2a8JUv6G)
INSERT INTO usuarios (nombre, email, password_hash, restaurante_id, rol, email_verified, created_at)
VALUES (
    'Laura Cocinera', 
    'laura@lanave5', 
    '$2a$10$aZemRdOtz3zTnkj4mTtHpOBgIbfCnGTPx44.GWqwaKlLq2a8JUv6G', 
    3, 
    'cocinera', 
    TRUE,
    NOW()
);

COMMIT;

-- VERIFICACIÓN
SELECT id, nombre, email, restaurante_id, rol, email_verified 
FROM usuarios 
WHERE email = 'laura@lanave5';
