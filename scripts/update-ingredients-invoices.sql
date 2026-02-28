-- Actualización de Ingredientes basados en Albaranes Reales (Linxi, Videla, Colo Fruits)
-- Base de datos: lacaleta102_demo
-- V2: Usando UPSERT manual (UPDATE + INSERT WHERE NOT EXISTS)

BEGIN;

-- ==========================================
-- 1. PATATAS (Estilo: Precio Saco)
-- ==========================================
-- UPDATE Agria
UPDATE ingredientes SET precio = 14.50, cantidad_por_formato = 25.00, formato_compra = 'Saco 25kg', proveedor_id = (SELECT id FROM proveedores WHERE nombre = 'COLO FRUITS' LIMIT 1) WHERE nombre = 'Patata Agria';
-- INSERT Agria
INSERT INTO ingredientes (restaurante_id, nombre, precio, unidad, cantidad_por_formato, formato_compra, familia, proveedor_id)
SELECT 1, 'Patata Agria', 14.50, 'kg', 25.00, 'Saco 25kg', 'Alimento', (SELECT id FROM proveedores WHERE nombre = 'COLO FRUITS' LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM ingredientes WHERE nombre = 'Patata Agria');

-- UPDATE Monalisa
UPDATE ingredientes SET precio = 15.00, cantidad_por_formato = 25.00, formato_compra = 'Saco 25kg', proveedor_id = (SELECT id FROM proveedores WHERE nombre = 'COLO FRUITS' LIMIT 1) WHERE nombre = 'Patata Monalisa';
-- INSERT Monalisa
INSERT INTO ingredientes (restaurante_id, nombre, precio, unidad, cantidad_por_formato, formato_compra, familia, proveedor_id)
SELECT 1, 'Patata Monalisa', 15.00, 'kg', 25.00, 'Saco 25kg', 'Alimento', (SELECT id FROM proveedores WHERE nombre = 'COLO FRUITS' LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM ingredientes WHERE nombre = 'Patata Monalisa');

-- Actualizar Patata genérica para que tenga sentido
UPDATE ingredientes SET precio = 14.50, cantidad_por_formato = 25.00, formato_compra = 'Saco 25kg' WHERE nombre = 'Patata';

-- ==========================================
-- 2. VERDURAS & FRUTAS (COLO FRUITS)
-- ==========================================
-- Cebolla Seca: 0.78 kg * 25 = 19.50
UPDATE ingredientes SET precio = 19.50, cantidad_por_formato = 25.00, formato_compra = 'Saco 25kg' WHERE nombre ILIKE 'Cebolla%';

-- Zanahoria: 0.96 €/kg
UPDATE ingredientes SET precio = 0.96, cantidad_por_formato = 1.00, formato_compra = 'Kg' WHERE nombre = 'Zanahoria';

-- Pimiento Rojo: 3.31 €/kg
UPDATE ingredientes SET precio = 3.31, cantidad_por_formato = 1.00, formato_compra = 'Kg' WHERE nombre = 'Pimiento rojo';

-- Berenjena: 2.23 €/kg
UPDATE ingredientes SET precio = 2.23, cantidad_por_formato = 1.00, formato_compra = 'Kg' WHERE nombre = 'Berenjena';

-- ==========================================
-- 3. ABARROTES (COLO FRUITS)
-- ==========================================
-- Harina 1kg: 1.14€
UPDATE ingredientes SET precio = 1.14, cantidad_por_formato = 1.00, formato_compra = 'Paquete 1kg' WHERE nombre LIKE 'Harina%';

-- Azucar 1kg: 1.36€
UPDATE ingredientes SET precio = 1.36, cantidad_por_formato = 1.00, formato_compra = 'Paquete 1kg' WHERE nombre = 'Azúcar';

-- Sal Fina 1kg: 0.54€
UPDATE ingredientes SET precio = 0.54, cantidad_por_formato = 1.00, formato_compra = 'Paquete 1kg' WHERE nombre ILIKE 'Sal%';

-- Tomate Triturado 5kg: 6.01€ (Lata)
UPDATE ingredientes SET precio = 6.01, cantidad_por_formato = 5.00, formato_compra = 'Lata 5kg' WHERE nombre = 'Tomate Triturado Martinete';
INSERT INTO ingredientes (restaurante_id, nombre, precio, unidad, cantidad_por_formato, formato_compra, familia)
SELECT 1, 'Tomate Triturado Martinete', 6.01, 'kg', 5.00, 'Lata 5kg', 'Alimento'
WHERE NOT EXISTS (SELECT 1 FROM ingredientes WHERE nombre = 'Tomate Triturado Martinete');

-- ==========================================
-- 4. CARNES (LINXI / VIDELA)
-- ==========================================
UPDATE ingredientes SET precio = 10.30 WHERE nombre = 'Masa Hamburguesa Ternera';
INSERT INTO ingredientes (restaurante_id, nombre, precio, unidad, cantidad_por_formato, formato_compra, familia)
SELECT 1, 'Masa Hamburguesa Ternera', 10.30, 'kg', 1.00, 'Kg', 'Alimento' WHERE NOT EXISTS (SELECT 1 FROM ingredientes WHERE nombre = 'Masa Hamburguesa Ternera');

UPDATE ingredientes SET precio = 6.13 WHERE nombre = 'Masa Salchicha Cerdo';
INSERT INTO ingredientes (restaurante_id, nombre, precio, unidad, cantidad_por_formato, formato_compra, familia)
SELECT 1, 'Masa Salchicha Cerdo', 6.13, 'kg', 1.00, 'Kg', 'Alimento' WHERE NOT EXISTS (SELECT 1 FROM ingredientes WHERE nombre = 'Masa Salchicha Cerdo');

UPDATE ingredientes SET precio = 5.75 WHERE nombre = 'Costilla Cerdo Entera';
INSERT INTO ingredientes (restaurante_id, nombre, precio, unidad, cantidad_por_formato, formato_compra, familia)
SELECT 1, 'Costilla Cerdo Entera', 5.75, 'kg', 1.00, 'Kg', 'Alimento' WHERE NOT EXISTS (SELECT 1 FROM ingredientes WHERE nombre = 'Costilla Cerdo Entera');

UPDATE ingredientes SET precio = 5.13 WHERE nombre = 'Espinazo Cerdo';
INSERT INTO ingredientes (restaurante_id, nombre, precio, unidad, cantidad_por_formato, formato_compra, familia)
SELECT 1, 'Espinazo Cerdo', 5.13, 'kg', 1.00, 'Kg', 'Alimento' WHERE NOT EXISTS (SELECT 1 FROM ingredientes WHERE nombre = 'Espinazo Cerdo');

-- ==========================================
-- 5. PESCADOS (LINXI / VIDELA)
-- ==========================================
UPDATE ingredientes SET precio = 14.55 WHERE nombre = 'Sepia Limpia';
INSERT INTO ingredientes (restaurante_id, nombre, precio, unidad, cantidad_por_formato, formato_compra, familia)
SELECT 1, 'Sepia Limpia', 14.55, 'kg', 1.00, 'Kg', 'Alimento' WHERE NOT EXISTS (SELECT 1 FROM ingredientes WHERE nombre = 'Sepia Limpia');

UPDATE ingredientes SET precio = 11.29 WHERE nombre = 'Morralla Pescado';
INSERT INTO ingredientes (restaurante_id, nombre, precio, unidad, cantidad_por_formato, formato_compra, familia)
SELECT 1, 'Morralla Pescado', 11.29, 'kg', 1.00, 'Kg', 'Alimento' WHERE NOT EXISTS (SELECT 1 FROM ingredientes WHERE nombre = 'Morralla Pescado');

UPDATE ingredientes SET precio = 7.80 WHERE nombre = 'Lubina';
INSERT INTO ingredientes (restaurante_id, nombre, precio, unidad, cantidad_por_formato, formato_compra, familia)
SELECT 1, 'Lubina', 7.80, 'kg', 1.00, 'Kg', 'Alimento' WHERE NOT EXISTS (SELECT 1 FROM ingredientes WHERE nombre = 'Lubina');

UPDATE ingredientes SET precio = 19.33 WHERE nombre = 'Almeja Japonesa';
INSERT INTO ingredientes (restaurante_id, nombre, precio, unidad, cantidad_por_formato, formato_compra, familia)
SELECT 1, 'Almeja Japonesa', 19.33, 'kg', 1.00, 'Kg', 'Alimento' WHERE NOT EXISTS (SELECT 1 FROM ingredientes WHERE nombre = 'Almeja Japonesa');

-- Bacalao: Ticket 120.90 / Unidad.
UPDATE ingredientes SET precio = 120.90, unidad = 'ud', cantidad_por_formato = 1.00, formato_compra = 'Pieza Grande' WHERE nombre = 'Bacalao Congelado';
INSERT INTO ingredientes (restaurante_id, nombre, precio, unidad, cantidad_por_formato, formato_compra, familia)
SELECT 1, 'Bacalao Congelado', 120.90, 'ud', 1.00, 'Pieza Grande', 'Alimento' WHERE NOT EXISTS (SELECT 1 FROM ingredientes WHERE nombre = 'Bacalao Congelado');

COMMIT;
