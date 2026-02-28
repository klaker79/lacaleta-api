require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

(async () => {
    try {
        const email = 'demo@lacaleta102.com';
        const newPassword = '123456'; // Generic simple password for demo
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(newPassword, salt);

        const res = await pool.query(
            'UPDATE usuarios SET password_hash = $1, email_verified = true WHERE email = $2 RETURNING id, email',
            [hash, email]
        );

        if (res.rowCount > 0) {
            console.log(`✅ Password reset successful for: ${res.rows[0].email}`);
            console.log(`🔑 New Password: ${newPassword}`);
        } else {
            console.error('❌ User not found!');
        }
    } catch (err) {
        console.error('Error resetting password:', err);
    } finally {
        await pool.end();
    }
})();
