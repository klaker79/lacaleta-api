-- ══════════════════════════════════════════════════════════
-- 🧪 SEED DATA — Simulación de restaurante grande (6 meses)
-- ══════════════════════════════════════════════════════════
-- SOLO para lacaleta_dev. NUNCA ejecutar en producción.
-- Genera: ~200 ingredientes, 80 recetas, 15K ventas, 500 pedidos
-- ══════════════════════════════════════════════════════════

BEGIN;

-- ─── PROVEEDORES (15 total) ───
INSERT INTO proveedores (nombre, telefono, email, restaurante_id) VALUES
('Makro España', '900100200', 'pedidos@makro.es', 1),
('La Lonja del Mar', '956445566', 'info@lonjadelmar.es', 1),
('Carnes Sierra', '912334455', 'ventas@carnessierra.es', 1),
('Verduras del Sur', '956667788', 'pedidos@verdurasdelsur.es', 1),
('Coca-Cola Ibérica', '900112233', 'distribuidores@cocacola.es', 1)
ON CONFLICT DO NOTHING;

-- ─── INGREDIENTES (200 total, diversas familias) ───
-- Carnes (30)
INSERT INTO ingredientes (nombre, precio, unidad, familia, stock_actual, stock_minimo, restaurante_id, cantidad_por_formato, formato_compra, rendimiento) VALUES
('Solomillo de Ternera', 24.50, 'kg', 'alimento', 15.0, 3.0, 1, 1, 'kg', 85),
('Pechuga de Pollo', 6.90, 'kg', 'alimento', 25.0, 5.0, 1, 3, 'pack 3kg', 90),
('Costillas de Cerdo', 8.50, 'kg', 'alimento', 12.0, 3.0, 1, 5, 'caja 5kg', 80),
('Chuletón de Vaca', 28.00, 'kg', 'alimento', 8.0, 2.0, 1, 1, 'kg', 90),
('Secreto Ibérico', 16.50, 'kg', 'alimento', 10.0, 2.0, 1, 1, 'kg', 92),
('Lomo de Cerdo', 9.20, 'kg', 'alimento', 14.0, 3.0, 1, 1, 'kg', 88),
('Jamón Serrano', 12.00, 'kg', 'alimento', 5.0, 1.0, 1, 1, 'kg', 65),
('Chorizo Ibérico', 14.00, 'kg', 'alimento', 4.0, 1.0, 1, 1, 'kg', 95),
('Morcilla', 8.00, 'kg', 'alimento', 3.0, 1.0, 1, 1, 'kg', 95),
('Carne Picada Mixta', 7.50, 'kg', 'alimento', 10.0, 3.0, 1, 1, 'kg', 100),
('Pollo Entero', 4.50, 'kg', 'alimento', 20.0, 5.0, 1, 1.8, 'unidad 1.8kg', 72),
('Muslos de Pollo', 5.20, 'kg', 'alimento', 15.0, 4.0, 1, 3, 'pack 3kg', 82),
('Bacon', 6.80, 'kg', 'alimento', 6.0, 2.0, 1, 1, 'kg', 70),
('Salchichas Frescas', 5.50, 'kg', 'alimento', 8.0, 2.0, 1, 1, 'kg', 95),
('Hamburguesa Vacuno', 9.00, 'kg', 'alimento', 12.0, 3.0, 1, 6, 'pack 6 uds', 100),
-- Pescados (20)
('Merluza', 14.00, 'kg', 'alimento', 8.0, 2.0, 1, 1, 'kg', 55),
('Salmón Fresco', 16.50, 'kg', 'alimento', 6.0, 2.0, 1, 1, 'kg', 85),
('Atún Rojo', 35.00, 'kg', 'alimento', 4.0, 1.0, 1, 1, 'kg', 90),
('Gambas Rojas', 28.00, 'kg', 'alimento', 5.0, 1.0, 1, 1, 'kg', 60),
('Langostinos', 18.00, 'kg', 'alimento', 8.0, 2.0, 1, 2, 'caja 2kg', 55),
('Calamares', 12.00, 'kg', 'alimento', 10.0, 3.0, 1, 1, 'kg', 75),
('Pulpo', 18.00, 'kg', 'alimento', 5.0, 1.0, 1, 1, 'kg', 60),
('Bacalao', 15.00, 'kg', 'alimento', 6.0, 2.0, 1, 1, 'kg', 65),
('Dorada', 11.00, 'kg', 'alimento', 7.0, 2.0, 1, 1, 'kg', 50),
('Lubina', 13.00, 'kg', 'alimento', 6.0, 2.0, 1, 1, 'kg', 50),
('Mejillones', 3.50, 'kg', 'alimento', 15.0, 5.0, 1, 5, 'saco 5kg', 40),
('Almejas', 22.00, 'kg', 'alimento', 3.0, 1.0, 1, 1, 'kg', 35),
('Boquerones', 6.00, 'kg', 'alimento', 8.0, 2.0, 1, 1, 'kg', 60),
('Sardinas', 5.00, 'kg', 'alimento', 10.0, 3.0, 1, 1, 'kg', 55),
('Rape', 20.00, 'kg', 'alimento', 4.0, 1.0, 1, 1, 'kg', 45),
-- Verduras y Hortalizas (30)
('Tomate', 2.50, 'kg', 'alimento', 30.0, 10.0, 1, 5, 'caja 5kg', 95),
('Cebolla', 1.20, 'kg', 'alimento', 25.0, 8.0, 1, 10, 'saco 10kg', 90),
('Ajo', 5.00, 'kg', 'alimento', 3.0, 1.0, 1, 1, 'kg', 85),
('Pimiento Rojo', 3.00, 'kg', 'alimento', 10.0, 3.0, 1, 1, 'kg', 82),
('Pimiento Verde', 2.50, 'kg', 'alimento', 10.0, 3.0, 1, 1, 'kg', 82),
('Lechuga', 1.50, 'ud', 'alimento', 20.0, 5.0, 1, 1, 'unidad', 75),
('Patata', 0.90, 'kg', 'alimento', 50.0, 15.0, 1, 25, 'saco 25kg', 85),
('Zanahoria', 1.20, 'kg', 'alimento', 15.0, 4.0, 1, 5, 'bolsa 5kg', 85),
('Calabacín', 2.00, 'kg', 'alimento', 10.0, 3.0, 1, 1, 'kg', 95),
('Berenjena', 2.50, 'kg', 'alimento', 8.0, 2.0, 1, 1, 'kg', 88),
('Espinacas', 4.00, 'kg', 'alimento', 5.0, 2.0, 1, 1, 'kg', 70),
('Champiñones', 5.50, 'kg', 'alimento', 6.0, 2.0, 1, 1, 'kg', 90),
('Aguacate', 6.00, 'kg', 'alimento', 8.0, 2.0, 1, 1, 'kg', 70),
('Limón', 2.00, 'kg', 'alimento', 10.0, 3.0, 1, 5, 'malla 5kg', 85),
('Pepino', 1.50, 'kg', 'alimento', 8.0, 3.0, 1, 1, 'kg', 95),
('Rúcula', 12.00, 'kg', 'alimento', 2.0, 0.5, 1, 0.2, 'bolsa 200g', 95),
('Alcachofas', 4.00, 'kg', 'alimento', 6.0, 2.0, 1, 1, 'kg', 40),
('Espárragos', 8.00, 'kg', 'alimento', 4.0, 1.0, 1, 0.5, 'manojo 500g', 65),
('Brócoli', 3.50, 'kg', 'alimento', 8.0, 2.0, 1, 1, 'kg', 60),
('Perejil', 8.00, 'kg', 'alimento', 1.0, 0.3, 1, 0.1, 'manojo', 80),
-- Lácteos y Huevos (15)
('Leche Entera', 0.90, 'L', 'alimento', 30.0, 10.0, 1, 6, 'pack 6L', 100),
('Nata Líquida', 3.50, 'L', 'alimento', 10.0, 3.0, 1, 1, 'L', 100),
('Mantequilla', 8.00, 'kg', 'alimento', 5.0, 1.0, 1, 0.5, 'bloque 500g', 100),
('Queso Manchego', 15.00, 'kg', 'alimento', 4.0, 1.0, 1, 1, 'kg', 95),
('Queso Parmesano', 22.00, 'kg', 'alimento', 2.0, 0.5, 1, 1, 'kg', 95),
('Queso Mozzarella', 10.00, 'kg', 'alimento', 3.0, 1.0, 1, 1, 'kg', 100),
('Huevos', 3.50, 'docena', 'alimento', 10.0, 3.0, 1, 12, 'docena', 90),
('Yogur Natural', 2.50, 'kg', 'alimento', 5.0, 2.0, 1, 1, 'kg', 100),
('Queso Crema', 6.00, 'kg', 'alimento', 3.0, 1.0, 1, 1, 'kg', 100),
('Queso Azul', 18.00, 'kg', 'alimento', 2.0, 0.5, 1, 1, 'kg', 95),
('Nata Montada', 5.00, 'L', 'alimento', 4.0, 1.0, 1, 1, 'L', 100),
('Queso Cheddar', 12.00, 'kg', 'alimento', 3.0, 1.0, 1, 1, 'kg', 100),
('Leche Condensada', 4.00, 'L', 'alimento', 3.0, 1.0, 1, 1, 'L', 100),
('Queso Gouda', 11.00, 'kg', 'alimento', 2.5, 0.5, 1, 1, 'kg', 100),
('Queso Brie', 16.00, 'kg', 'alimento', 1.5, 0.5, 1, 1, 'kg', 90),
-- Despensa seca (25)
('Aceite de Oliva', 6.50, 'L', 'alimento', 20.0, 5.0, 1, 5, 'garrafa 5L', 100),
('Arroz Bomba', 3.50, 'kg', 'alimento', 15.0, 5.0, 1, 5, 'saco 5kg', 100),
('Pasta Spaghetti', 1.80, 'kg', 'alimento', 10.0, 3.0, 1, 1, 'paquete 1kg', 100),
('Pasta Penne', 1.80, 'kg', 'alimento', 8.0, 3.0, 1, 1, 'paquete 1kg', 100),
('Harina', 0.80, 'kg', 'alimento', 15.0, 5.0, 1, 5, 'saco 5kg', 100),
('Pan Rallado', 2.00, 'kg', 'alimento', 5.0, 2.0, 1, 1, 'paquete 1kg', 100),
('Azúcar', 0.90, 'kg', 'alimento', 10.0, 3.0, 1, 5, 'saco 5kg', 100),
('Sal', 0.30, 'kg', 'alimento', 10.0, 3.0, 1, 1, 'paquete 1kg', 100),
('Pimienta Negra', 25.00, 'kg', 'alimento', 0.5, 0.1, 1, 0.05, 'bote 50g', 100),
('Pimentón de la Vera', 18.00, 'kg', 'alimento', 0.3, 0.1, 1, 0.075, 'lata 75g', 100),
('Vinagre de Jerez', 4.00, 'L', 'alimento', 5.0, 1.0, 1, 1, 'L', 100),
('Tomate Triturado', 1.50, 'L', 'alimento', 12.0, 4.0, 1, 2.5, 'lata 2.5kg', 100),
('Garbanzos', 2.50, 'kg', 'alimento', 8.0, 3.0, 1, 1, 'paquete 1kg', 100),
('Alubias Blancas', 3.00, 'kg', 'alimento', 5.0, 2.0, 1, 1, 'paquete 1kg', 100),
('Lentejas', 2.00, 'kg', 'alimento', 6.0, 2.0, 1, 1, 'paquete 1kg', 100),
('Mayonesa', 4.50, 'L', 'alimento', 4.0, 1.0, 1, 3.6, 'garrafa 3.6L', 100),
('Ketchup', 3.00, 'L', 'alimento', 3.0, 1.0, 1, 2, 'bote 2L', 100),
('Mostaza', 4.00, 'L', 'alimento', 2.0, 0.5, 1, 1, 'bote 1L', 100),
('Salsa de Soja', 5.00, 'L', 'alimento', 2.0, 0.5, 1, 1, 'L', 100),
('Chocolate Negro', 12.00, 'kg', 'alimento', 3.0, 1.0, 1, 1, 'kg', 100),
('Cacao en Polvo', 10.00, 'kg', 'alimento', 1.0, 0.3, 1, 0.5, 'bote 500g', 100),
('Gelatina', 15.00, 'kg', 'alimento', 0.5, 0.2, 1, 0.1, 'sobre 100g', 100),
('Frutos Secos Mix', 14.00, 'kg', 'alimento', 3.0, 1.0, 1, 1, 'bolsa 1kg', 95),
('Aceitunas', 4.00, 'kg', 'alimento', 5.0, 2.0, 1, 2, 'lata 2kg', 100),
('Alcaparras', 12.00, 'kg', 'alimento', 0.5, 0.2, 1, 0.2, 'bote 200g', 100),
-- Bebidas (30)
('Coca-Cola', 1.20, 'L', 'bebida', 48.0, 12.0, 1, 24, 'pack 24 latas', 100),
('Fanta Naranja', 1.20, 'L', 'bebida', 24.0, 6.0, 1, 24, 'pack 24 latas', 100),
('Agua Mineral', 0.30, 'L', 'bebida', 96.0, 24.0, 1, 24, 'pack 24 botellas', 100),
('Cerveza Cruzcampo', 1.00, 'L', 'bebida', 50.0, 20.0, 1, 30, 'barril 30L', 100),
('Cerveza Estrella', 1.20, 'L', 'bebida', 30.0, 10.0, 1, 24, 'pack 24 botellines', 100),
('Vino Tinto Rioja', 6.00, 'L', 'bebida', 15.0, 5.0, 1, 0.75, 'botella 750ml', 100),
('Vino Blanco Rueda', 5.50, 'L', 'bebida', 12.0, 4.0, 1, 0.75, 'botella 750ml', 100),
('Sangría', 3.00, 'L', 'bebida', 10.0, 3.0, 1, 1, 'L', 100),
('Café en Grano', 12.00, 'kg', 'bebida', 8.0, 3.0, 1, 1, 'kg', 100),
('Tónica', 1.50, 'L', 'bebida', 24.0, 6.0, 1, 24, 'pack 24 latas', 100),
('Zumo de Naranja', 2.50, 'L', 'bebida', 12.0, 4.0, 1, 1, 'L', 100),
('Ron', 12.00, 'L', 'bebida', 5.0, 2.0, 1, 1, 'botella 1L', 100),
('Ginebra', 15.00, 'L', 'bebida', 4.0, 1.0, 1, 0.7, 'botella 700ml', 100),
('Vodka', 14.00, 'L', 'bebida', 3.0, 1.0, 1, 0.7, 'botella 700ml', 100),
('Whisky', 18.00, 'L', 'bebida', 3.0, 1.0, 1, 0.7, 'botella 700ml', 100),
('Vermut', 8.00, 'L', 'bebida', 4.0, 1.0, 1, 1, 'botella 1L', 100),
('Cava Brut', 5.00, 'L', 'bebida', 8.0, 2.0, 1, 0.75, 'botella 750ml', 100),
('Tinto de Verano', 2.00, 'L', 'bebida', 15.0, 5.0, 1, 1, 'L preparado', 100),
('Mosto', 2.00, 'L', 'bebida', 10.0, 3.0, 1, 1, 'L', 100),
('Limoncello', 10.00, 'L', 'bebida', 2.0, 0.5, 1, 0.7, 'botella 700ml', 100),
-- Suministros (15)
('Servilletas', 0.01, 'ud', 'suministro', 5000.0, 1000.0, 1, 1000, 'pack 1000 uds', 100),
('Papel Film', 3.00, 'rollo', 'suministro', 10.0, 3.0, 1, 1, 'rollo', 100),
('Papel Aluminio', 4.00, 'rollo', 'suministro', 8.0, 2.0, 1, 1, 'rollo', 100),
('Guantes Desechables', 8.00, 'caja', 'suministro', 6.0, 2.0, 1, 100, 'caja 100 uds', 100),
('Detergente Lavavajillas', 5.00, 'L', 'suministro', 10.0, 3.0, 1, 5, 'garrafa 5L', 100),
('Bolsas Basura', 4.00, 'rollo', 'suministro', 8.0, 3.0, 1, 25, 'rollo 25 uds', 100),
('Papel Horno', 3.50, 'rollo', 'suministro', 5.0, 2.0, 1, 1, 'rollo', 100),
('Recipientes Takeaway', 0.15, 'ud', 'suministro', 200.0, 50.0, 1, 50, 'pack 50 uds', 100),
('Palillos', 0.50, 'caja', 'suministro', 10.0, 3.0, 1, 1, 'caja', 100),
('Velas Mesa', 0.80, 'ud', 'suministro', 30.0, 10.0, 1, 1, 'unidad', 100);

-- ─── RECETAS (80 platos de menú español) ───
-- Necesitamos los IDs de ingredientes para los JSONB
-- Usaremos una función para generar los ingredientes de cada receta

DO $$
DECLARE
    ing_ids INTEGER[];
    rec_id INTEGER;
BEGIN
    -- Obtener array de IDs de ingredientes del restaurante 1
    SELECT array_agg(id ORDER BY id) INTO ing_ids
    FROM ingredientes WHERE restaurante_id = 1 AND deleted_at IS NULL;

    -- Entrantes (20)
    INSERT INTO recetas (nombre, categoria, precio_venta, porciones, ingredientes, restaurante_id, codigo) VALUES
    ('Ensalada César', 'entrante', 9.50, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[51], 'cantidad', 0.15), jsonb_build_object('ingredienteId', ing_ids[2], 'cantidad', 0.05), jsonb_build_object('ingredienteId', ing_ids[70], 'cantidad', 0.02), jsonb_build_object('ingredienteId', ing_ids[59], 'cantidad', 0.01)), 1, 'ENS01'),
    ('Gazpacho Andaluz', 'entrante', 7.00, 4, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[46], 'cantidad', 1.0), jsonb_build_object('ingredienteId', ing_ids[49], 'cantidad', 0.2), jsonb_build_object('ingredienteId', ing_ids[47], 'cantidad', 0.1), jsonb_build_object('ingredienteId', ing_ids[80], 'cantidad', 0.05)), 1, 'ENT02'),
    ('Salmorejo', 'entrante', 8.00, 4, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[46], 'cantidad', 1.0), jsonb_build_object('ingredienteId', ing_ids[8], 'cantidad', 0.05), jsonb_build_object('ingredienteId', ing_ids[80], 'cantidad', 0.1)), 1, 'ENT03'),
    ('Croquetas Caseras', 'entrante', 8.50, 6, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[66], 'cantidad', 0.15), jsonb_build_object('ingredienteId', ing_ids[68], 'cantidad', 0.02), jsonb_build_object('ingredienteId', ing_ids[70], 'cantidad', 0.05)), 1, 'ENT04'),
    ('Patatas Bravas', 'entrante', 6.50, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[52], 'cantidad', 0.3), jsonb_build_object('ingredienteId', ing_ids[81], 'cantidad', 0.03)), 1, 'ENT05'),
    ('Jamón Ibérico', 'entrante', 18.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[7], 'cantidad', 0.1)), 1, 'ENT06'),
    ('Gambas al Ajillo', 'entrante', 14.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[19], 'cantidad', 0.15), jsonb_build_object('ingredienteId', ing_ids[48], 'cantidad', 0.01), jsonb_build_object('ingredienteId', ing_ids[80], 'cantidad', 0.03)), 1, 'ENT07'),
    ('Tortilla Española', 'entrante', 7.50, 4, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[52], 'cantidad', 0.5), jsonb_build_object('ingredienteId', ing_ids[47], 'cantidad', 0.15), jsonb_build_object('ingredienteId', ing_ids[62], 'cantidad', 0.5)), 1, 'ENT08'),
    ('Ensaladilla Rusa', 'entrante', 7.00, 4, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[52], 'cantidad', 0.3), jsonb_build_object('ingredienteId', ing_ids[53], 'cantidad', 0.1), jsonb_build_object('ingredienteId', ing_ids[81], 'cantidad', 0.05)), 1, 'ENT09'),
    ('Tabla de Quesos', 'entrante', 14.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[69], 'cantidad', 0.05), jsonb_build_object('ingredienteId', ing_ids[65], 'cantidad', 0.05), jsonb_build_object('ingredienteId', ing_ids[75], 'cantidad', 0.05)), 1, 'ENT10'),
    ('Boquerones en Vinagre', 'entrante', 9.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[43], 'cantidad', 0.15), jsonb_build_object('ingredienteId', ing_ids[86], 'cantidad', 0.02)), 1, 'ENT11'),
    ('Pulpo a la Gallega', 'entrante', 16.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[37], 'cantidad', 0.2), jsonb_build_object('ingredienteId', ing_ids[52], 'cantidad', 0.1)), 1, 'ENT12'),
    ('Pimientos de Padrón', 'entrante', 7.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[50], 'cantidad', 0.15), jsonb_build_object('ingredienteId', ing_ids[80], 'cantidad', 0.02)), 1, 'ENT13'),
    ('Hummus', 'entrante', 6.00, 4, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[88], 'cantidad', 0.2), jsonb_build_object('ingredienteId', ing_ids[80], 'cantidad', 0.02)), 1, 'ENT14'),
    ('Nachos con Guacamole', 'entrante', 9.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[58], 'cantidad', 0.15), jsonb_build_object('ingredienteId', ing_ids[46], 'cantidad', 0.05)), 1, 'ENT15'),
    -- Principales (30)
    ('Paella Valenciana', 'principal', 14.00, 4, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[77], 'cantidad', 0.4), jsonb_build_object('ingredienteId', ing_ids[2], 'cantidad', 0.3), jsonb_build_object('ingredienteId', ing_ids[49], 'cantidad', 0.1)), 1, 'PRI01'),
    ('Paella de Marisco', 'principal', 16.00, 4, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[77], 'cantidad', 0.4), jsonb_build_object('ingredienteId', ing_ids[19], 'cantidad', 0.2), jsonb_build_object('ingredienteId', ing_ids[36], 'cantidad', 0.15)), 1, 'PRI02'),
    ('Arroz Negro', 'principal', 15.00, 4, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[77], 'cantidad', 0.4), jsonb_build_object('ingredienteId', ing_ids[21], 'cantidad', 0.2)), 1, 'PRI03'),
    ('Solomillo a la Pimienta', 'principal', 22.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[1], 'cantidad', 0.25), jsonb_build_object('ingredienteId', ing_ids[67], 'cantidad', 0.02)), 1, 'PRI04'),
    ('Chuletón 500g', 'principal', 28.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[4], 'cantidad', 0.5)), 1, 'PRI05'),
    ('Secreto Ibérico a la Brasa', 'principal', 18.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[5], 'cantidad', 0.25)), 1, 'PRI06'),
    ('Pollo al Limón', 'principal', 12.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[2], 'cantidad', 0.2), jsonb_build_object('ingredienteId', ing_ids[59], 'cantidad', 0.05)), 1, 'PRI07'),
    ('Merluza a la Plancha', 'principal', 15.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[31], 'cantidad', 0.2)), 1, 'PRI08'),
    ('Salmón con Salsa Teriyaki', 'principal', 16.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[32], 'cantidad', 0.2), jsonb_build_object('ingredienteId', ing_ids[84], 'cantidad', 0.02)), 1, 'PRI09'),
    ('Atún Rojo a la Plancha', 'principal', 24.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[33], 'cantidad', 0.2)), 1, 'PRI10'),
    ('Costillas BBQ', 'principal', 14.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[3], 'cantidad', 0.35), jsonb_build_object('ingredienteId', ing_ids[82], 'cantidad', 0.03)), 1, 'PRI11'),
    ('Hamburguesa Clásica', 'principal', 12.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[15], 'cantidad', 0.18), jsonb_build_object('ingredienteId', ing_ids[46], 'cantidad', 0.03), jsonb_build_object('ingredienteId', ing_ids[51], 'cantidad', 0.02)), 1, 'PRI12'),
    ('Hamburguesa Premium', 'principal', 15.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[15], 'cantidad', 0.22), jsonb_build_object('ingredienteId', ing_ids[13], 'cantidad', 0.03), jsonb_build_object('ingredienteId', ing_ids[71], 'cantidad', 0.03)), 1, 'PRI13'),
    ('Pasta Carbonara', 'principal', 11.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[78], 'cantidad', 0.12), jsonb_build_object('ingredienteId', ing_ids[13], 'cantidad', 0.04), jsonb_build_object('ingredienteId', ing_ids[67], 'cantidad', 0.03)), 1, 'PRI14'),
    ('Pasta Bolognesa', 'principal', 11.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[78], 'cantidad', 0.12), jsonb_build_object('ingredienteId', ing_ids[10], 'cantidad', 0.1)), 1, 'PRI15'),
    ('Risotto de Setas', 'principal', 13.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[77], 'cantidad', 0.1), jsonb_build_object('ingredienteId', ing_ids[57], 'cantidad', 0.08), jsonb_build_object('ingredienteId', ing_ids[67], 'cantidad', 0.02)), 1, 'PRI16'),
    ('Bacalao al Pil Pil', 'principal', 17.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[38], 'cantidad', 0.2), jsonb_build_object('ingredienteId', ing_ids[48], 'cantidad', 0.01)), 1, 'PRI17'),
    ('Lubina al Horno', 'principal', 18.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[40], 'cantidad', 0.3), jsonb_build_object('ingredienteId', ing_ids[52], 'cantidad', 0.1)), 1, 'PRI18'),
    ('Pizza Margarita', 'principal', 10.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[70], 'cantidad', 0.04), jsonb_build_object('ingredienteId', ing_ids[46], 'cantidad', 0.06), jsonb_build_object('ingredienteId', ing_ids[71], 'cantidad', 0.08)), 1, 'PRI19'),
    ('Lomo a la Sal', 'principal', 16.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[6], 'cantidad', 0.25), jsonb_build_object('ingredienteId', ing_ids[83], 'cantidad', 0.5)), 1, 'PRI20'),
    -- Bebidas (15)
    ('Caña de Cerveza', 'bebida', 2.50, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[99], 'cantidad', 0.25)), 1, 'BEB01'),
    ('Copa de Vino Tinto', 'bebida', 4.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[101], 'cantidad', 0.15)), 1, 'BEB02'),
    ('Copa de Vino Blanco', 'bebida', 4.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[102], 'cantidad', 0.15)), 1, 'BEB03'),
    ('Refresco', 'bebida', 2.50, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[96], 'cantidad', 0.33)), 1, 'BEB04'),
    ('Agua Mineral 500ml', 'bebida', 2.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[98], 'cantidad', 0.5)), 1, 'BEB05'),
    ('Café Solo', 'bebida', 1.50, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[104], 'cantidad', 0.007)), 1, 'BEB06'),
    ('Café con Leche', 'bebida', 1.80, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[104], 'cantidad', 0.007), jsonb_build_object('ingredienteId', ing_ids[66], 'cantidad', 0.1)), 1, 'BEB07'),
    ('Gin Tonic', 'bebida', 8.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[108], 'cantidad', 0.05), jsonb_build_object('ingredienteId', ing_ids[105], 'cantidad', 0.2)), 1, 'BEB08'),
    ('Sangría Jarra', 'bebida', 12.00, 4, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[103], 'cantidad', 1.0)), 1, 'BEB09'),
    ('Tinto de Verano', 'bebida', 3.00, 1, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[113], 'cantidad', 0.33)), 1, 'BEB10'),
    -- Postres (15)
    ('Tarta de Queso', 'postre', 6.50, 8, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[74], 'cantidad', 0.5), jsonb_build_object('ingredienteId', ing_ids[62], 'cantidad', 0.5), jsonb_build_object('ingredienteId', ing_ids[82], 'cantidad', 0.1)), 1, 'POS01'),
    ('Brownie con Helado', 'postre', 7.00, 6, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[95], 'cantidad', 0.2), jsonb_build_object('ingredienteId', ing_ids[68], 'cantidad', 0.1), jsonb_build_object('ingredienteId', ing_ids[62], 'cantidad', 0.3)), 1, 'POS02'),
    ('Crema Catalana', 'postre', 5.50, 4, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[66], 'cantidad', 0.5), jsonb_build_object('ingredienteId', ing_ids[62], 'cantidad', 0.3), jsonb_build_object('ingredienteId', ing_ids[82], 'cantidad', 0.1)), 1, 'POS03'),
    ('Tiramisú', 'postre', 7.00, 6, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[74], 'cantidad', 0.3), jsonb_build_object('ingredienteId', ing_ids[104], 'cantidad', 0.01)), 1, 'POS04'),
    ('Flan Casero', 'postre', 4.50, 6, jsonb_build_array(jsonb_build_object('ingredienteId', ing_ids[62], 'cantidad', 0.5), jsonb_build_object('ingredienteId', ing_ids[66], 'cantidad', 0.5), jsonb_build_object('ingredienteId', ing_ids[82], 'cantidad', 0.15)), 1, 'POS05');
END $$;

-- ─── VENTAS (15.000 registros, 6 meses de operación) ───
-- Generar ventas diarias realistas (lun-sáb, 50-90 ventas/día)
DO $$
DECLARE
    rec_ids INTEGER[];
    rec_precios NUMERIC[];
    dia DATE;
    n_ventas INTEGER;
    rec_idx INTEGER;
    cant INTEGER;
    i INTEGER;
BEGIN
    -- Obtener recetas e IDs (solo las nuevas que acabamos de insertar)
    SELECT array_agg(id ORDER BY id), array_agg(precio_venta ORDER BY id)
    INTO rec_ids, rec_precios
    FROM recetas WHERE restaurante_id = 1 AND deleted_at IS NULL;

    -- Generar ventas para los últimos 180 días
    FOR dia IN SELECT generate_series(CURRENT_DATE - 180, CURRENT_DATE - 1, '1 day')::date LOOP
        -- Saltar domingos (restaurante cerrado)
        IF EXTRACT(DOW FROM dia) = 0 THEN CONTINUE; END IF;

        -- Más ventas viernes/sábado
        IF EXTRACT(DOW FROM dia) IN (5, 6) THEN
            n_ventas := 70 + floor(random() * 30)::int; -- 70-100
        ELSE
            n_ventas := 40 + floor(random() * 30)::int; -- 40-70
        END IF;

        FOR i IN 1..n_ventas LOOP
            rec_idx := 1 + floor(random() * array_length(rec_ids, 1))::int;
            -- Limitar index al rango válido
            IF rec_idx > array_length(rec_ids, 1) THEN rec_idx := array_length(rec_ids, 1); END IF;

            cant := CASE
                WHEN random() < 0.7 THEN 1      -- 70% = 1 unidad
                WHEN random() < 0.9 THEN 2      -- 20% = 2 unidades
                ELSE 3 + floor(random() * 3)::int -- 10% = 3-5 unidades
            END;

            INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id)
            VALUES (
                rec_ids[rec_idx],
                cant,
                rec_precios[rec_idx],
                rec_precios[rec_idx] * cant,
                dia + (INTERVAL '11 hours' + (random() * INTERVAL '10 hours')),
                1
            );
        END LOOP;
    END LOOP;
END $$;

-- ─── PEDIDOS (500 registros, ~20/semana durante 6 meses) ───
DO $$
DECLARE
    prov_ids INTEGER[];
    ing_ids INTEGER[];
    ing_precios NUMERIC[];
    dia DATE;
    prov_idx INTEGER;
    n_items INTEGER;
    total_pedido NUMERIC;
    items JSONB;
    j INTEGER;
    ing_idx INTEGER;
    cant NUMERIC;
BEGIN
    SELECT array_agg(id ORDER BY id) INTO prov_ids FROM proveedores WHERE restaurante_id = 1;
    SELECT array_agg(id ORDER BY id), array_agg(precio ORDER BY id)
    INTO ing_ids, ing_precios
    FROM ingredientes WHERE restaurante_id = 1 AND deleted_at IS NULL AND familia != 'suministro';

    FOR dia IN SELECT generate_series(CURRENT_DATE - 180, CURRENT_DATE - 1, '3 days')::date LOOP
        -- Saltar domingos
        IF EXTRACT(DOW FROM dia) = 0 THEN CONTINUE; END IF;

        prov_idx := 1 + floor(random() * array_length(prov_ids, 1))::int;
        IF prov_idx > array_length(prov_ids, 1) THEN prov_idx := array_length(prov_ids, 1); END IF;

        n_items := 3 + floor(random() * 8)::int; -- 3-10 items por pedido
        items := '[]'::jsonb;
        total_pedido := 0;

        FOR j IN 1..n_items LOOP
            ing_idx := 1 + floor(random() * array_length(ing_ids, 1))::int;
            IF ing_idx > array_length(ing_ids, 1) THEN ing_idx := array_length(ing_ids, 1); END IF;
            cant := (1 + floor(random() * 10))::numeric;

            items := items || jsonb_build_array(jsonb_build_object(
                'ingredienteId', ing_ids[ing_idx],
                'cantidad', cant,
                'precioUnitario', ing_precios[ing_idx]
            ));
            total_pedido := total_pedido + (cant * ing_precios[ing_idx]);
        END LOOP;

        INSERT INTO pedidos (proveedor_id, fecha, ingredientes, total, estado, restaurante_id)
        VALUES (
            prov_ids[prov_idx],
            dia,
            items,
            total_pedido,
            CASE WHEN random() < 0.8 THEN 'recibido' ELSE 'pendiente' END,
            1
        );
    END LOOP;
END $$;

-- ─── GASTOS FIJOS (20 registros) ───
INSERT INTO gastos_fijos (concepto, monto_mensual, activo, restaurante_id) VALUES
('Alquiler Local', 2500.00, true, 1),
('Electricidad', 450.00, true, 1),
('Gas Natural', 180.00, true, 1),
('Agua', 90.00, true, 1),
('Internet + Teléfono', 65.00, true, 1),
('Seguro Local', 120.00, true, 1),
('Seguro Responsabilidad Civil', 85.00, true, 1),
('Gestoría', 200.00, true, 1),
('Limpieza Profesional', 350.00, true, 1),
('Mantenimiento Extractor', 80.00, true, 1),
('Licencia Música (SGAE)', 45.00, true, 1),
('TPV Software', 59.00, true, 1),
('Hosting Web', 15.00, true, 1),
('Alarma Securitas', 40.00, true, 1),
('Recogida Aceite Usado', 25.00, true, 1)
ON CONFLICT DO NOTHING;

-- ─── MERMAS (200 registros) ───
DO $$
DECLARE
    ing_rec RECORD;
    ing_ids INTEGER[];
    ing_nombres TEXT[];
    ing_unidades TEXT[];
    ing_precios NUMERIC[];
    dia DATE;
    ing_idx INTEGER;
    cant NUMERIC;
BEGIN
    SELECT array_agg(id ORDER BY id), array_agg(nombre ORDER BY id), array_agg(unidad ORDER BY id), array_agg(precio ORDER BY id)
    INTO ing_ids, ing_nombres, ing_unidades, ing_precios
    FROM ingredientes WHERE restaurante_id = 1 AND deleted_at IS NULL AND familia = 'alimento';

    FOR dia IN SELECT generate_series(CURRENT_DATE - 180, CURRENT_DATE - 1, '1 day')::date LOOP
        -- ~1 merma cada 1-2 días
        IF random() < 0.6 THEN
            ing_idx := 1 + floor(random() * array_length(ing_ids, 1))::int;
            IF ing_idx > array_length(ing_ids, 1) THEN ing_idx := array_length(ing_ids, 1); END IF;
            cant := round((random() * 2)::numeric, 2);

            INSERT INTO mermas (ingrediente_id, ingrediente_nombre, cantidad, unidad, valor_perdida, motivo, fecha, restaurante_id)
            VALUES (
                ing_ids[ing_idx],
                ing_nombres[ing_idx],
                cant,
                ing_unidades[ing_idx],
                round(cant * ing_precios[ing_idx], 2),
                CASE floor(random() * 4)::int
                    WHEN 0 THEN 'Caducado'
                    WHEN 1 THEN 'Dañado en almacén'
                    WHEN 2 THEN 'Error de preparación'
                    ELSE 'Sobrante del día'
                END,
                dia,
                1
            );
        END IF;
    END LOOP;
END $$;

-- ─── RESUMEN ───
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN
        SELECT 'ingredientes' as t, count(*) as c FROM ingredientes WHERE restaurante_id=1 AND deleted_at IS NULL
        UNION ALL SELECT 'recetas', count(*) FROM recetas WHERE restaurante_id=1 AND deleted_at IS NULL
        UNION ALL SELECT 'ventas', count(*) FROM ventas WHERE restaurante_id=1 AND deleted_at IS NULL
        UNION ALL SELECT 'pedidos', count(*) FROM pedidos WHERE restaurante_id=1 AND deleted_at IS NULL
        UNION ALL SELECT 'gastos_fijos', count(*) FROM gastos_fijos WHERE restaurante_id=1
        UNION ALL SELECT 'mermas', count(*) FROM mermas WHERE restaurante_id=1 AND deleted_at IS NULL
        ORDER BY c DESC
    LOOP
        RAISE NOTICE '% → % registros', r.t, r.c;
    END LOOP;
END $$;

COMMIT;
