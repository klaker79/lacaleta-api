-- Migración: Tabla de alertas
-- Ejecutar: psql -U postgres -d lacaleta -f migrations/002_create_alerts_table.sql

CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY,
    restaurant_id INTEGER NOT NULL,
    type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'warning',
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    title VARCHAR(200) NOT NULL,
    message TEXT,
    entity_type VARCHAR(50),
    entity_id INTEGER,
    data JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    acknowledged_at TIMESTAMP,
    acknowledged_by INTEGER,
    resolved_at TIMESTAMP
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_alerts_restaurant_status ON alerts(restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_alerts_entity ON alerts(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(restaurant_id, severity) WHERE status = 'active';

-- Comentario
COMMENT ON TABLE alerts IS 'Sistema de alertas automáticas de margen, food cost y stock';
