-- Migración: Tabla de movimientos de stock
-- Ejecutar: psql -U postgres -d lacaleta -f migrations/003_create_stock_movements.sql

CREATE TABLE IF NOT EXISTS stock_movements (
    id SERIAL PRIMARY KEY,
    restaurant_id INTEGER NOT NULL,
    ingredient_id INTEGER NOT NULL,
    movement_type VARCHAR(20) NOT NULL, -- purchase, sale, waste, adjustment
    quantity DECIMAL(10,3) NOT NULL, -- positivo = entrada, negativo = salida
    reference_type VARCHAR(20), -- purchase, sale, waste
    reference_id INTEGER,
    notes TEXT,
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_stock_movements_ingredient ON stock_movements(ingredient_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements(restaurant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_type ON stock_movements(restaurant_id, movement_type);

-- Comentario
COMMENT ON TABLE stock_movements IS 'Historial de movimientos de stock (compras, ventas, mermas)';
