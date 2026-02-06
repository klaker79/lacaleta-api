const path = require('path');
const dotenvPath = path.resolve(__dirname, '../.env');
console.log('Cargando .env desde:', dotenvPath);
require('dotenv').config({ path: dotenvPath });

const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'lacaleta_dev',
    password: process.env.DB_PASSWORD || '',
    port: process.env.DB_PORT || 5432,
});

async function fixSchema() {
    console.log('🔧 Verificando esquema de tabla ALERTS...');

    try {
        const client = await pool.connect();

        // 1. Verificar si la columna severity existe
        const res = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='alerts' AND column_name='severity';
        `);

        if (res.rows.length === 0) {
            console.log('⚠️ Columna "severity" no encontrada. Creándola...');
            await client.query(`
                ALTER TABLE alerts 
                ADD COLUMN IF NOT EXISTS severity VARCHAR(20) NOT NULL DEFAULT 'warning';
            `);
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(restaurant_id, severity) WHERE status = 'active';
            `);
            console.log('✅ Columna severity creada correctamente.');
        } else {
            console.log('✅ La columna "severity" ya existe.');
        }

        // 2. Verificar índices clave
        await client.query(`
             CREATE INDEX IF NOT EXISTS idx_alerts_restaurant_status ON alerts(restaurant_id, status);
        `);
        console.log('✅ Índices verificados.');

        client.release();
    } catch (err) {
        console.error('❌ Error arreglando esquema:', err);
    } finally {
        await pool.end();
    }
}

fixSchema();
