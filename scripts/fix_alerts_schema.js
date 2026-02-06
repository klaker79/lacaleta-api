const path = require('path');

// Intentar cargar dotenv
try {
    require('dotenv').config({ path: path.join(__dirname, '../.env') });
} catch (e) {
    require(path.join(__dirname, '../node_modules/dotenv')).config({ path: path.join(__dirname, '../.env') });
}

let Pool;
try {
    Pool = require('pg').Pool;
} catch (e) {
    Pool = require(path.join(__dirname, '../node_modules/pg')).Pool;
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
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
