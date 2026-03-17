-- ============================================================
-- DEMO DATA: La Caleta 102 (Barcelona)
-- Base de datos: lacaleta102_demo
-- ⚠️ NO EJECUTAR EN lacaleta_dev (La Nave 5)
-- ============================================================

BEGIN;

-- 1. RESTAURANTE
INSERT INTO restaurantes (id, nombre, email) VALUES
(1, 'La Caleta 102', 'info@lacaleta102.com');

-- Reset sequence
SELECT setval('restaurantes_id_seq', 1);

-- 2. USUARIO DEMO (password: demo1234)
INSERT INTO usuarios (id, restaurante_id, email, password_hash, nombre, rol, email_verified) VALUES
(1, 1, 'demo@lacaleta102.com', '$2b$10$LK8LVJX5C6q2fUzVtRbXXOz4X5K5U5b5b5b5b5b5b5b5b5b5b5b5b5', 'Demo La Caleta 102', 'admin', true);

SELECT setval('usuarios_id_seq', 1);

-- 3. PROVEEDORES (inventados pero realistas para Barcelona)
INSERT INTO proveedores (id, nombre, contacto, telefono, email, restaurante_id) VALUES
(1, 'Mercabarna Fresh', 'Carlos Martínez', '934 567 890', 'pedidos@mercabarnafresh.es', 1),
(2, 'Pescados del Mediterráneo', 'María García', '932 345 678', 'info@pescadosmed.es', 1),
(3, 'Carnes Selectas BCN', 'Joan Puig', '931 234 567', 'pedidos@carnesbcn.es', 1),
(4, 'Distribuciones Lácteas', 'Ana López', '935 678 901', 'ventas@distlacteas.es', 1),
(5, 'Vins i Licors Barcelona', 'Pere Sala', '936 789 012', 'comercial@vinsbcn.es', 1);

SELECT setval('proveedores_id_seq', 5);

-- 4. INGREDIENTES con precios de mercado Barcelona
INSERT INTO ingredientes (id, nombre, precio, unidad, stock_actual, stock_minimo, familia, restaurante_id, formato_compra, cantidad_por_formato, rendimiento) VALUES
-- Verduras y hortalizas
(1,  'Patata',               1.20, 'kg', 25.00, 5.00, 'alimento', 1, 'Saco 25kg', 25, 85),
(2,  'Zanahoria',            1.50, 'kg', 10.00, 3.00, 'alimento', 1, 'Caja 10kg', 10, 80),
(3,  'Guisantes congelados', 2.80, 'kg',  5.00, 2.00, 'alimento', 1, 'Bolsa 2.5kg', 2.5, 100),
(4,  'Cebolla',              1.40, 'kg', 15.00, 5.00, 'alimento', 1, 'Saco 10kg', 10, 90),
(5,  'Berenjena',            2.80, 'kg',  5.00, 2.00, 'alimento', 1, 'Caja 5kg', 5, 75),
(6,  'Pimiento rojo',        3.20, 'kg',  5.00, 2.00, 'alimento', 1, 'Caja 5kg', 5, 80),
(7,  'Tomates cherry',       5.50, 'kg',  3.00, 1.00, 'alimento', 1, 'Bandeja 500g', 0.5, 95),
(8,  'Puerro',               2.80, 'kg',  5.00, 2.00, 'alimento', 1, 'Manojo 1kg', 1, 70),
(9,  'Apio',                 2.50, 'kg',  2.00, 1.00, 'alimento', 1, 'Pieza', 1, 65),
(10, 'Ajo',                  6.00, 'kg',  2.00, 0.50, 'alimento', 1, 'Ristra 500g', 0.5, 85),
-- Pescados y mariscos
(11, 'Ventresca de atún',   38.00, 'kg',  2.00, 0.50, 'alimento', 1, 'Pieza al vacío', 1, 95),
(12, 'Atún rojo (lomo)',    28.00, 'kg',  3.00, 1.00, 'alimento', 1, 'Pieza al vacío', 2, 90),
(13, 'Anchoas en salazón',  32.00, 'kg',  1.00, 0.50, 'alimento', 1, 'Lata 1kg', 1, 60),
(14, 'Huevas de trucha',    45.00, 'kg',  0.50, 0.20, 'alimento', 1, 'Tarro 100g', 0.1, 100),
(15, 'Gamba roja',          42.00, 'kg',  3.00, 1.00, 'alimento', 1, 'Caja 2kg', 2, 65),
(16, 'Almejas',             18.00, 'kg',  2.00, 1.00, 'alimento', 1, 'Malla 1kg', 1, 70),
(17, 'Mejillones de roca',   6.50, 'kg',  5.00, 2.00, 'alimento', 1, 'Malla 2kg', 2, 45),
(18, 'Bacalao fresco',      16.00, 'kg',  3.00, 1.00, 'alimento', 1, 'Pieza', 3, 75),
-- Carnes
(19, 'Rabo de toro',        14.50, 'kg',  5.00, 2.00, 'alimento', 1, 'Pieza 3kg', 3, 60),
(20, 'Carrillera ibérica',  12.00, 'kg',  3.00, 1.00, 'alimento', 1, 'Bandeja 1kg', 1, 85),
(21, 'Pato (magret)',       22.00, 'kg',  2.00, 1.00, 'alimento', 1, 'Pieza al vacío', 0.4, 90),
(22, 'Foie micuit',         65.00, 'kg',  1.00, 0.50, 'alimento', 1, 'Lingote 500g', 0.5, 95),
(23, 'Txuletón madurado',   28.00, 'kg',  5.00, 2.00, 'alimento', 1, 'Pieza 1.2kg', 1.2, 80),
-- Lácteos y huevos
(24, 'Huevos camperos',      0.25, 'ud',  60.00, 24.00, 'alimento', 1, 'Docena', 12, 100),
(25, 'Mayonesa',             4.50, 'kg',  3.00, 1.00, 'alimento', 1, 'Bote 2kg', 2, 100),
(26, 'Nata 35%',             4.50, 'L',   5.00, 2.00, 'alimento', 1, 'Brick 1L', 1, 100),
(27, 'Leche entera',         0.90, 'L',  10.00, 3.00, 'alimento', 1, 'Brick 1L', 1, 100),
(28, 'Mantequilla',          8.50, 'kg',  3.00, 1.00, 'alimento', 1, 'Bloque 1kg', 1, 100),
(29, 'Yema de huevo',        5.50, 'kg',  2.00, 0.50, 'alimento', 1, 'Brick 1kg', 1, 100),
-- Secos y especias
(30, 'Harina de trigo',      0.90, 'kg', 10.00, 3.00, 'alimento', 1, 'Saco 5kg', 5, 100),
(31, 'Azúcar',               1.00, 'kg',  5.00, 2.00, 'alimento', 1, 'Saco 5kg', 5, 100),
(32, 'Sal',                  0.60, 'kg',  5.00, 2.00, 'alimento', 1, 'Saco 5kg', 5, 100),
(33, 'Pimienta negra',      18.00, 'kg',  0.50, 0.20, 'alimento', 1, 'Bote 500g', 0.5, 100),
(34, 'Aceite de oliva VE',   7.00, 'L',  10.00, 3.00, 'alimento', 1, 'Garrafa 5L', 5, 100),
(35, 'Mostaza Dijon',        6.00, 'kg',  1.00, 0.50, 'alimento', 1, 'Tarro 1kg', 1, 100),
(36, 'Alcaparrones',         8.50, 'kg',  1.00, 0.50, 'alimento', 1, 'Tarro 1kg', 1, 100),
(37, 'Maizena',              3.50, 'kg',  2.00, 0.50, 'alimento', 1, 'Paquete 1kg', 1, 100),
(38, 'Canela en rama',      25.00, 'kg',  0.20, 0.10, 'alimento', 1, 'Bolsa 100g', 0.1, 100),
(39, 'Romero fresco',        3.00, 'kg',  0.30, 0.10, 'alimento', 1, 'Manojo', 0.1, 100),
-- Chocolate y repostería
(40, 'Cobertura choco leche',12.00, 'kg',  3.00, 1.00, 'alimento', 1, 'Tableta 1kg', 1, 100),
(41, 'Chocolate blanco',    14.00, 'kg',  2.00, 0.50, 'alimento', 1, 'Tableta 1kg', 1, 100),
(42, 'Cacao en polvo',      15.00, 'kg',  1.00, 0.50, 'alimento', 1, 'Bolsa 1kg', 1, 100),
(43, 'Azúcar glass',         2.00, 'kg',  2.00, 0.50, 'alimento', 1, 'Bolsa 1kg', 1, 100),
(44, 'Aceite de girasol',    2.20, 'L',   5.00, 2.00, 'alimento', 1, 'Garrafa 5L', 5, 100),
(45, 'Carquiñolis',         12.00, 'kg',  1.00, 0.50, 'alimento', 1, 'Bolsa 500g', 0.5, 100),
-- Otros
(46, 'Limón',                2.50, 'kg',  3.00, 1.00, 'alimento', 1, 'Malla 2kg', 2, 70),
(47, 'Naranja',              2.00, 'kg',  3.00, 1.00, 'alimento', 1, 'Caja 10kg', 10, 65),
(48, 'Alcaparras',          12.00, 'kg',  0.50, 0.20, 'alimento', 1, 'Tarro 500g', 0.5, 100),
(49, 'Semillas de sésamo',   8.00, 'kg',  0.50, 0.20, 'alimento', 1, 'Bolsa 500g', 0.5, 100);

SELECT setval('ingredientes_id_seq', 49);

-- 5. RECETAS con ingredientes JSONB y costes calculados

-- ENSALADILLA RUSA (x4 raciones) → PVP 9€
INSERT INTO recetas (id, nombre, precio_venta, porciones, raciones, ingredientes, restaurante_id, categoria_id, coste_calculado, coste_por_racion, margen_porcentaje, food_cost, descripcion) VALUES
(1, 'Ensaladilla Rusa', 9.00, 4, 4,
 '[{"ingrediente_id":1,"nombre":"Patata","cantidad":100,"unidad":"g"},{"ingrediente_id":2,"nombre":"Zanahoria","cantidad":50,"unidad":"g"},{"ingrediente_id":3,"nombre":"Guisantes","cantidad":50,"unidad":"g"},{"ingrediente_id":24,"nombre":"Huevo campero","cantidad":1,"unidad":"ud"},{"ingrediente_id":25,"nombre":"Mayonesa","cantidad":50,"unidad":"g"},{"ingrediente_id":11,"nombre":"Ventresca de atún","cantidad":25,"unidad":"g"},{"ingrediente_id":32,"nombre":"Sal","cantidad":2,"unidad":"g"},{"ingrediente_id":33,"nombre":"Pimienta","cantidad":1,"unidad":"g"}]',
 1, NULL, 8.59, 2.15, 76.11, 23.89, 'Con ventresca de atún. Alérgenos: Huevos, Lácteos, Pescado');

-- COCA DE ESCALIVADA (x15 raciones) → PVP 12€
INSERT INTO recetas (id, nombre, precio_venta, porciones, raciones, ingredientes, restaurante_id, categoria_id, coste_calculado, coste_por_racion, margen_porcentaje, food_cost, descripcion) VALUES
(2, 'Coca de Escalivada', 12.00, 15, 15,
 '[{"ingrediente_id":30,"nombre":"Harina de trigo","cantidad":1000,"unidad":"g"},{"ingrediente_id":28,"nombre":"Mantequilla","cantidad":500,"unidad":"g"},{"ingrediente_id":5,"nombre":"Berenjena","cantidad":400,"unidad":"g"},{"ingrediente_id":6,"nombre":"Pimiento rojo","cantidad":800,"unidad":"g"},{"ingrediente_id":4,"nombre":"Cebolla","cantidad":400,"unidad":"g"},{"ingrediente_id":7,"nombre":"Tomates cherry","cantidad":100,"unidad":"g"},{"ingrediente_id":34,"nombre":"Aceite de oliva","cantidad":100,"unidad":"ml"},{"ingrediente_id":10,"nombre":"Ajo","cantidad":10,"unidad":"g"},{"ingrediente_id":13,"nombre":"Anchoas","cantidad":150,"unidad":"g"},{"ingrediente_id":36,"nombre":"Alcaparrones","cantidad":50,"unidad":"g"}]',
 1, NULL, 54.87, 3.66, 69.50, 30.50, 'Con anchoa y tomate marinado. Alérgenos: Lácteos, Gluten, Pescado');

-- TATAKI DE ATÚN ROJO BLUEFIN → PVP 18€
INSERT INTO recetas (id, nombre, precio_venta, porciones, raciones, ingredientes, restaurante_id, categoria_id, coste_calculado, coste_por_racion, margen_porcentaje, food_cost, descripcion) VALUES
(3, 'Tataki de Atún Rojo Bluefin', 18.00, 1, 1,
 '[{"ingrediente_id":12,"nombre":"Atún rojo lomo","cantidad":150,"unidad":"g"},{"ingrediente_id":10,"nombre":"Ajo (chips)","cantidad":5,"unidad":"g"},{"ingrediente_id":48,"nombre":"Alcaparras","cantidad":10,"unidad":"g"},{"ingrediente_id":14,"nombre":"Huevas de trucha","cantidad":10,"unidad":"g"},{"ingrediente_id":49,"nombre":"Sésamo","cantidad":3,"unidad":"g"},{"ingrediente_id":34,"nombre":"Aceite de oliva","cantidad":15,"unidad":"ml"}]',
 1, NULL, 5.13, 5.13, 71.50, 28.50, 'Con helado de mostaza. Alérgenos: Pescado, Gluten, Lácteos, Huevos, Mostaza, Sésamo');

-- RABO DE TORO (x15 raciones) → PVP 18€ (asumido)
INSERT INTO recetas (id, nombre, precio_venta, porciones, raciones, ingredientes, restaurante_id, categoria_id, coste_calculado, coste_por_racion, margen_porcentaje, food_cost, descripcion) VALUES
(4, 'Rabo de Toro', 18.00, 15, 15,
 '[{"ingrediente_id":19,"nombre":"Rabo de toro","cantidad":3000,"unidad":"g"},{"ingrediente_id":4,"nombre":"Cebolla picada","cantidad":1500,"unidad":"g"},{"ingrediente_id":8,"nombre":"Puerro picado","cantidad":500,"unidad":"g"},{"ingrediente_id":2,"nombre":"Zanahoria picada","cantidad":500,"unidad":"g"},{"ingrediente_id":6,"nombre":"Pimiento rojo","cantidad":700,"unidad":"g"},{"ingrediente_id":10,"nombre":"Ajo","cantidad":100,"unidad":"g"},{"ingrediente_id":9,"nombre":"Apio","cantidad":200,"unidad":"g"}]',
 1, NULL, 51.64, 3.44, 80.89, 19.11, 'Guiso de rabo con parmentier. Alérgenos: Gluten, Sulfitos, Lácteos');

-- TEXTURAS DE CHOCOLATE → PVP estimado 10€
INSERT INTO recetas (id, nombre, precio_venta, porciones, raciones, ingredientes, restaurante_id, categoria_id, coste_calculado, coste_por_racion, margen_porcentaje, food_cost, descripcion) VALUES
(5, 'Texturas de Chocolate', 10.00, 10, 10,
 '[{"ingrediente_id":26,"nombre":"Nata 35%","cantidad":500,"unidad":"ml"},{"ingrediente_id":27,"nombre":"Leche entera","cantidad":600,"unidad":"ml"},{"ingrediente_id":31,"nombre":"Azúcar","cantidad":200,"unidad":"g"},{"ingrediente_id":29,"nombre":"Yemas de huevo","cantidad":200,"unidad":"g"},{"ingrediente_id":40,"nombre":"Cobertura choco leche","cantidad":1000,"unidad":"g"},{"ingrediente_id":41,"nombre":"Chocolate blanco","cantidad":220,"unidad":"g"},{"ingrediente_id":28,"nombre":"Mantequilla","cantidad":140,"unidad":"g"},{"ingrediente_id":43,"nombre":"Azúcar glass","cantidad":80,"unidad":"g"},{"ingrediente_id":42,"nombre":"Cacao","cantidad":205,"unidad":"g"}]',
 1, NULL, 24.92, 2.49, 75.10, 24.90, 'Ganache, tierra, teja y sopa de chocolate. Alérgenos: Lácteos, Gluten, Frutos secos, Huevos');

-- CREMA CATALANA → PVP estimado 9€
INSERT INTO recetas (id, nombre, precio_venta, porciones, raciones, ingredientes, restaurante_id, categoria_id, coste_calculado, coste_por_racion, margen_porcentaje, food_cost, descripcion) VALUES
(6, 'Crema Catalana', 9.00, 8, 8,
 '[{"ingrediente_id":27,"nombre":"Leche entera","cantidad":1000,"unidad":"ml"},{"ingrediente_id":31,"nombre":"Azúcar","cantidad":200,"unidad":"g"},{"ingrediente_id":37,"nombre":"Maizena","cantidad":70,"unidad":"g"},{"ingrediente_id":46,"nombre":"Limón (piel)","cantidad":20,"unidad":"g"},{"ingrediente_id":47,"nombre":"Naranja (piel)","cantidad":20,"unidad":"g"},{"ingrediente_id":38,"nombre":"Canela en rama","cantidad":5,"unidad":"g"},{"ingrediente_id":29,"nombre":"Yemas","cantidad":120,"unidad":"g"},{"ingrediente_id":45,"nombre":"Carquiñolis","cantidad":100,"unidad":"g"}]',
 1, NULL, 3.65, 0.46, 94.89, 5.11, 'Semiesfera con caseado de caramelo y tierra de carquiñolis. Alérgenos: Lácteos, Huevos, Gluten');

-- Más platos de la carta (con datos estimados)

-- BRAVAS "LA CALETA" → PVP 7€
INSERT INTO recetas (id, nombre, precio_venta, porciones, raciones, ingredientes, restaurante_id, categoria_id, coste_calculado, coste_por_racion, margen_porcentaje, food_cost, descripcion) VALUES
(7, 'Bravas La Caleta', 7.00, 1, 1,
 '[{"ingrediente_id":1,"nombre":"Patata","cantidad":200,"unidad":"g"},{"ingrediente_id":34,"nombre":"Aceite de oliva","cantidad":100,"unidad":"ml"},{"ingrediente_id":10,"nombre":"Ajo","cantidad":5,"unidad":"g"},{"ingrediente_id":6,"nombre":"Pimiento rojo (salsa)","cantidad":30,"unidad":"g"},{"ingrediente_id":32,"nombre":"Sal","cantidad":3,"unidad":"g"}]',
 1, NULL, 1.63, 1.63, 76.71, 23.29, 'Patatas bravas estilo La Caleta');

-- CROQUETAS DE LA CASA → PVP 12€
INSERT INTO recetas (id, nombre, precio_venta, porciones, raciones, ingredientes, restaurante_id, categoria_id, coste_calculado, coste_por_racion, margen_porcentaje, food_cost, descripcion) VALUES
(8, 'Croquetas de la Casa', 12.00, 4, 4,
 '[{"ingrediente_id":23,"nombre":"Txuletón","cantidad":150,"unidad":"g"},{"ingrediente_id":15,"nombre":"Gamba","cantidad":100,"unidad":"g"},{"ingrediente_id":28,"nombre":"Mantequilla","cantidad":50,"unidad":"g"},{"ingrediente_id":30,"nombre":"Harina","cantidad":50,"unidad":"g"},{"ingrediente_id":27,"nombre":"Leche","cantidad":500,"unidad":"ml"}]',
 1, NULL, 11.64, 2.91, 75.75, 24.25, 'De txuletón y gamba (4 uds). Alérgenos: Gluten, Lácteos, Crustáceos');

-- PAN DE CRISTAL CON TOMATE → PVP 3.5€
INSERT INTO recetas (id, nombre, precio_venta, porciones, raciones, ingredientes, restaurante_id, categoria_id, coste_calculado, coste_por_racion, margen_porcentaje, food_cost, descripcion) VALUES
(9, 'Pan de Cristal con Tomate', 3.50, 1, 1,
 '[{"ingrediente_id":30,"nombre":"Pan de cristal","cantidad":80,"unidad":"g"},{"ingrediente_id":7,"nombre":"Tomate rallado","cantidad":40,"unidad":"g"},{"ingrediente_id":34,"nombre":"Aceite de oliva","cantidad":10,"unidad":"ml"}]',
 1, NULL, 0.36, 0.36, 89.71, 10.29, 'Pan de cristal con tomate rallado');

-- CANELÓN MELOSO → PVP 16€
INSERT INTO recetas (id, nombre, precio_venta, porciones, raciones, ingredientes, restaurante_id, categoria_id, coste_calculado, coste_por_racion, margen_porcentaje, food_cost, descripcion) VALUES
(10, 'Canelón Meloso', 16.00, 1, 1,
 '[{"ingrediente_id":21,"nombre":"Pato","cantidad":120,"unidad":"g"},{"ingrediente_id":22,"nombre":"Foie","cantidad":30,"unidad":"g"},{"ingrediente_id":30,"nombre":"Pasta canelón","cantidad":40,"unidad":"g"},{"ingrediente_id":26,"nombre":"Nata (bechamel)","cantidad":80,"unidad":"ml"},{"ingrediente_id":28,"nombre":"Mantequilla","cantidad":20,"unidad":"g"}]',
 1, NULL, 4.85, 4.85, 69.69, 30.31, 'Relleno con carne de pato y foie');

SELECT setval('recetas_id_seq', 10);

-- 6. VENTAS DEMO (3 semanas de datos ficticios)
-- Semana 1: 3-9 Feb 2026
-- Semana 2: 10-16 Feb 2026
-- Semana 3: 17-18 Feb 2026

INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id) VALUES
-- Semana 1 - Lunes 3 Feb
(9, 15, 3.50, 52.50, '2026-02-03 13:00:00', 1),
(7, 8, 7.00, 56.00, '2026-02-03 13:30:00', 1),
(1, 6, 9.00, 54.00, '2026-02-03 14:00:00', 1),
(8, 5, 12.00, 60.00, '2026-02-03 14:30:00', 1),
(3, 4, 18.00, 72.00, '2026-02-03 20:00:00', 1),
(4, 6, 18.00, 108.00, '2026-02-03 21:00:00', 1),
(5, 4, 10.00, 40.00, '2026-02-03 22:00:00', 1),
(6, 5, 9.00, 45.00, '2026-02-03 22:30:00', 1),
-- Martes 4 Feb
(9, 12, 3.50, 42.00, '2026-02-04 13:00:00', 1),
(7, 10, 7.00, 70.00, '2026-02-04 13:30:00', 1),
(2, 7, 12.00, 84.00, '2026-02-04 14:00:00', 1),
(10, 4, 16.00, 64.00, '2026-02-04 14:30:00', 1),
(3, 5, 18.00, 90.00, '2026-02-04 20:30:00', 1),
(4, 8, 18.00, 144.00, '2026-02-04 21:00:00', 1),
(5, 3, 10.00, 30.00, '2026-02-04 22:00:00', 1),
(6, 6, 9.00, 54.00, '2026-02-04 22:30:00', 1),
-- Miércoles 5 Feb
(9, 18, 3.50, 63.00, '2026-02-05 13:00:00', 1),
(1, 8, 9.00, 72.00, '2026-02-05 13:30:00', 1),
(7, 12, 7.00, 84.00, '2026-02-05 14:00:00', 1),
(8, 6, 12.00, 72.00, '2026-02-05 14:30:00', 1),
(3, 6, 18.00, 108.00, '2026-02-05 20:30:00', 1),
(2, 5, 12.00, 60.00, '2026-02-05 21:00:00', 1),
(5, 5, 10.00, 50.00, '2026-02-05 22:00:00', 1),
(6, 4, 9.00, 36.00, '2026-02-05 22:30:00', 1),
-- Jueves 6 Feb
(9, 14, 3.50, 49.00, '2026-02-06 13:00:00', 1),
(7, 9, 7.00, 63.00, '2026-02-06 13:30:00', 1),
(1, 5, 9.00, 45.00, '2026-02-06 14:00:00', 1),
(10, 3, 16.00, 48.00, '2026-02-06 14:30:00', 1),
(3, 7, 18.00, 126.00, '2026-02-06 20:30:00', 1),
(4, 5, 18.00, 90.00, '2026-02-06 21:00:00', 1),
(6, 7, 9.00, 63.00, '2026-02-06 22:00:00', 1),
-- Viernes 7 Feb (día fuerte)
(9, 22, 3.50, 77.00, '2026-02-07 13:00:00', 1),
(7, 15, 7.00, 105.00, '2026-02-07 13:30:00', 1),
(1, 10, 9.00, 90.00, '2026-02-07 14:00:00', 1),
(8, 8, 12.00, 96.00, '2026-02-07 14:30:00', 1),
(2, 9, 12.00, 108.00, '2026-02-07 15:00:00', 1),
(3, 10, 18.00, 180.00, '2026-02-07 20:30:00', 1),
(4, 9, 18.00, 162.00, '2026-02-07 21:00:00', 1),
(10, 6, 16.00, 96.00, '2026-02-07 21:30:00', 1),
(5, 7, 10.00, 70.00, '2026-02-07 22:00:00', 1),
(6, 8, 9.00, 72.00, '2026-02-07 22:30:00', 1),
-- Sábado 8 Feb (día más fuerte)
(9, 25, 3.50, 87.50, '2026-02-08 13:00:00', 1),
(7, 18, 7.00, 126.00, '2026-02-08 13:30:00', 1),
(1, 12, 9.00, 108.00, '2026-02-08 14:00:00', 1),
(8, 10, 12.00, 120.00, '2026-02-08 14:30:00', 1),
(2, 11, 12.00, 132.00, '2026-02-08 15:00:00', 1),
(3, 12, 18.00, 216.00, '2026-02-08 20:30:00', 1),
(4, 10, 18.00, 180.00, '2026-02-08 21:00:00', 1),
(10, 7, 16.00, 112.00, '2026-02-08 21:30:00', 1),
(5, 9, 10.00, 90.00, '2026-02-08 22:00:00', 1),
(6, 10, 9.00, 90.00, '2026-02-08 22:30:00', 1),
-- Domingo 9 Feb
(9, 20, 3.50, 70.00, '2026-02-09 13:00:00', 1),
(7, 14, 7.00, 98.00, '2026-02-09 13:30:00', 1),
(1, 9, 9.00, 81.00, '2026-02-09 14:00:00', 1),
(3, 8, 18.00, 144.00, '2026-02-09 20:30:00', 1),
(4, 7, 18.00, 126.00, '2026-02-09 21:00:00', 1),
(5, 6, 10.00, 60.00, '2026-02-09 22:00:00', 1),
(6, 7, 9.00, 63.00, '2026-02-09 22:30:00', 1),
-- Semana 2 - Lunes 10 Feb
(9, 13, 3.50, 45.50, '2026-02-10 13:00:00', 1),
(7, 7, 7.00, 49.00, '2026-02-10 13:30:00', 1),
(1, 5, 9.00, 45.00, '2026-02-10 14:00:00', 1),
(3, 4, 18.00, 72.00, '2026-02-10 20:30:00', 1),
(4, 5, 18.00, 90.00, '2026-02-10 21:00:00', 1),
(6, 4, 9.00, 36.00, '2026-02-10 22:00:00', 1),
-- Martes 11 Feb
(9, 16, 3.50, 56.00, '2026-02-11 13:00:00', 1),
(7, 11, 7.00, 77.00, '2026-02-11 13:30:00', 1),
(2, 6, 12.00, 72.00, '2026-02-11 14:00:00', 1),
(8, 5, 12.00, 60.00, '2026-02-11 14:30:00', 1),
(3, 5, 18.00, 90.00, '2026-02-11 20:30:00', 1),
(10, 4, 16.00, 64.00, '2026-02-11 21:00:00', 1),
(5, 4, 10.00, 40.00, '2026-02-11 22:00:00', 1),
(6, 5, 9.00, 45.00, '2026-02-11 22:30:00', 1),
-- Miércoles 12 Feb
(9, 17, 3.50, 59.50, '2026-02-12 13:00:00', 1),
(1, 7, 9.00, 63.00, '2026-02-12 13:30:00', 1),
(7, 10, 7.00, 70.00, '2026-02-12 14:00:00', 1),
(3, 6, 18.00, 108.00, '2026-02-12 20:30:00', 1),
(4, 6, 18.00, 108.00, '2026-02-12 21:00:00', 1),
(5, 5, 10.00, 50.00, '2026-02-12 22:00:00', 1),
(6, 6, 9.00, 54.00, '2026-02-12 22:30:00', 1),
-- Jueves 13 Feb
(9, 15, 3.50, 52.50, '2026-02-13 13:00:00', 1),
(7, 8, 7.00, 56.00, '2026-02-13 13:30:00', 1),
(2, 5, 12.00, 60.00, '2026-02-13 14:00:00', 1),
(10, 3, 16.00, 48.00, '2026-02-13 14:30:00', 1),
(3, 5, 18.00, 90.00, '2026-02-13 20:30:00', 1),
(4, 7, 18.00, 126.00, '2026-02-13 21:00:00', 1),
(6, 5, 9.00, 45.00, '2026-02-13 22:00:00', 1),
-- Viernes 14 Feb (San Valentín!)
(9, 28, 3.50, 98.00, '2026-02-14 13:00:00', 1),
(7, 20, 7.00, 140.00, '2026-02-14 13:30:00', 1),
(1, 14, 9.00, 126.00, '2026-02-14 14:00:00', 1),
(8, 12, 12.00, 144.00, '2026-02-14 14:30:00', 1),
(2, 10, 12.00, 120.00, '2026-02-14 15:00:00', 1),
(3, 15, 18.00, 270.00, '2026-02-14 20:30:00', 1),
(4, 12, 18.00, 216.00, '2026-02-14 21:00:00', 1),
(10, 8, 16.00, 128.00, '2026-02-14 21:30:00', 1),
(5, 12, 10.00, 120.00, '2026-02-14 22:00:00', 1),
(6, 14, 9.00, 126.00, '2026-02-14 22:30:00', 1),
-- Sábado 15 Feb
(9, 24, 3.50, 84.00, '2026-02-15 13:00:00', 1),
(7, 16, 7.00, 112.00, '2026-02-15 13:30:00', 1),
(1, 11, 9.00, 99.00, '2026-02-15 14:00:00', 1),
(8, 9, 12.00, 108.00, '2026-02-15 14:30:00', 1),
(3, 11, 18.00, 198.00, '2026-02-15 20:30:00', 1),
(4, 9, 18.00, 162.00, '2026-02-15 21:00:00', 1),
(10, 6, 16.00, 96.00, '2026-02-15 21:30:00', 1),
(5, 8, 10.00, 80.00, '2026-02-15 22:00:00', 1),
(6, 9, 9.00, 81.00, '2026-02-15 22:30:00', 1),
-- Domingo 16 Feb
(9, 19, 3.50, 66.50, '2026-02-16 13:00:00', 1),
(7, 13, 7.00, 91.00, '2026-02-16 13:30:00', 1),
(1, 8, 9.00, 72.00, '2026-02-16 14:00:00', 1),
(3, 7, 18.00, 126.00, '2026-02-16 20:30:00', 1),
(4, 6, 18.00, 108.00, '2026-02-16 21:00:00', 1),
(5, 5, 10.00, 50.00, '2026-02-16 22:00:00', 1),
(6, 7, 9.00, 63.00, '2026-02-16 22:30:00', 1),
-- Semana 3 - Lunes 17 Feb
(9, 14, 3.50, 49.00, '2026-02-17 13:00:00', 1),
(7, 9, 7.00, 63.00, '2026-02-17 13:30:00', 1),
(1, 6, 9.00, 54.00, '2026-02-17 14:00:00', 1),
(8, 4, 12.00, 48.00, '2026-02-17 14:30:00', 1),
(3, 5, 18.00, 90.00, '2026-02-17 20:30:00', 1),
(4, 6, 18.00, 108.00, '2026-02-17 21:00:00', 1),
(5, 4, 10.00, 40.00, '2026-02-17 22:00:00', 1),
(6, 5, 9.00, 45.00, '2026-02-17 22:30:00', 1),
-- Martes 18 Feb (hoy)
(9, 16, 3.50, 56.00, '2026-02-18 13:00:00', 1),
(7, 11, 7.00, 77.00, '2026-02-18 13:30:00', 1),
(2, 6, 12.00, 72.00, '2026-02-18 14:00:00', 1),
(3, 6, 18.00, 108.00, '2026-02-18 20:30:00', 1),
(10, 4, 16.00, 64.00, '2026-02-18 21:00:00', 1);

COMMIT;
