import pg from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const pool = new pg.Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function run() {
    try {
        console.log('🔌 Connecting to DB...');

        // 1. Ensure Restaurant 3 exists
        const resCheck = await pool.query('SELECT id FROM restaurantes WHERE id = 3');
        if (resCheck.rows.length === 0) {
            console.log('🏢 Creating Restaurant 3 (La Nave 5)...');
            // Note: If id is SERIAL, forcing it might require setting sequence or just simple insert if not taken
            await pool.query(`
                INSERT INTO restaurantes (id, nombre, email, created_at) 
                VALUES (3, 'La Nave 5', 'info@lanave5.com', NOW())
                ON CONFLICT (id) DO NOTHING
            `);
        } else {
            console.log('✅ Restaurant 3 already exists.');
        }

        // 2. Create/Update User laura@lanave5
        const email = 'laura@lanave5';
        const password = 'laura'; // Simple password for testing
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);

        const userCheck = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);

        if (userCheck.rows.length === 0) {
            console.log('👤 Creating user laura@lanave5...');
            await pool.query(`
                INSERT INTO usuarios (nombre, email, password_hash, restaurante_id, rol, email_verified)
                VALUES ('Laura Cocinera', $1, $2, 3, 'cocinera', TRUE)
            `, [email, hash]);
        } else {
            console.log('👤 User exists. Updating password and verifying...');
            await pool.query(`
                UPDATE usuarios 
                SET password_hash = $2, restaurante_id = 3, email_verified = TRUE 
                WHERE email = $1
            `, [email, hash]);
        }

        console.log(`✅ Setup complete.
        User: ${email}
        Pass: ${password}
        Restaurant ID: 3
        `);

    } catch (e) {
        console.error('❌ Error:', e);
    } finally {
        await pool.end();
    }
}

run();
