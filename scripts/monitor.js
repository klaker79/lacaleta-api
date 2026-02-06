const fs = require('fs');
const path = require('path');

// Intentar cargar desde la raíz si no se encuentra en local
try {
    require('dotenv').config({ path: path.join(__dirname, '../.env') });
} catch (e) {
    // Si falla, intentar buscar en node_modules del padre
    require(path.join(__dirname, '../node_modules/dotenv')).config({ path: path.join(__dirname, '../.env') });
}

let Resend;
try {
    Resend = require('resend').Resend;
} catch (e) {
    Resend = require(path.join(__dirname, '../node_modules/resend')).Resend;
}

// Configuración
const LOG_FILE = path.join(__dirname, '../server.log');
const EMAIL_DESTINO = 'ikerameas@gmail.com';
const PATRONES = /error|fail|exception|crashed|fatal/i;

async function checkLogs() {
    console.log(`🔍 [${new Date().toISOString()}] Revisando log: ${LOG_FILE}`);

    if (!fs.existsSync(LOG_FILE)) {
        console.error('❌ Error: No se encuentra el archivo server.log');
        return;
    }

    try {
        // Leer las últimas líneas del log de forma eficiente (últimos 10KB)
        const stats = fs.statSync(LOG_FILE);
        const bufferSize = 10 * 1024; // 10KB
        const start = Math.max(0, stats.size - bufferSize);

        const buffer = Buffer.alloc(Math.min(bufferSize, stats.size));
        const fd = fs.openSync(LOG_FILE, 'r');
        fs.readSync(fd, buffer, 0, buffer.length, start);
        fs.closeSync(fd);

        const contenido = buffer.toString('utf-8');
        const lineas = contenido.split('\n');

        // Tomamos las últimas 50 líneas para analizar
        const ultimas50Lineas = lineas.slice(-50);

        // Buscamos errores
        const errores = ultimas50Lineas.filter(line => PATRONES.test(line));

        if (errores.length > 0) {
            console.log(`⚠️  ¡PROBLEMAS DETECTADOS! (${errores.length} líneas sospechosas)`);

            // Comprobamos si ya avisamos recientemente (evitar spam)
            const lockFile = path.join(__dirname, '.monitor.lock');
            if (fs.existsSync(lockFile)) {
                const statLock = fs.statSync(lockFile);
                const ahora = new Date();
                const diffMinutos = (ahora - statLock.mtime) / 1000 / 60;

                if (diffMinutos < 60) {
                    console.log('⏳ Alerta pausada (ya se avisó hace menos de 1h).');
                    return;
                }
            }

            // Enviar Email
            if (process.env.RESEND_API_KEY) {
                const resend = new Resend(process.env.RESEND_API_KEY);

                const { data, error } = await resend.emails.send({
                    from: 'Vigilante CostOS <onboarding@resend.dev>',
                    to: EMAIL_DESTINO,
                    subject: '🚨 ALERTA: Errores detectados en La Nave 5',
                    html: `
                        <h2>⚠️ Se han detectado errores en el servidor</h2>
                        <p><strong>Fecha:</strong> ${new Date().toLocaleString('es-ES')}</p>
                        <p><strong>Log file:</strong> ${LOG_FILE}</p>
                        <hr>
                        <h3>Últimos errores encontrados:</h3>
                        <pre style="background: #f4f4f5; padding: 15px; border-radius: 5px; color: #dc2626; overflow-x: auto;">${errores.join('\n')}</pre>
                        <hr>
                        <p style="font-size: 12px; color: #666;">Este es un mensaje automático del sistema de monitorización.</p>
                    `
                });

                if (error) {
                    console.error('❌ Error enviando email:', error);
                } else {
                    console.log('✅ Alerta enviada correctamente:', data.id);
                    // Actualizar lock file
                    fs.writeFileSync(lockFile, new Date().toISOString());
                }
            } else {
                console.warn('⚠️ RESEND_API_KEY no configurada. No se pudo enviar email.');
                console.log('Errores:', errores);
            }
        } else {
            console.log('✅ Todo tranquilo. No se encontraron errores recientes.');
        }

    } catch (err) {
        console.error('❌ Error fatal en el monitor:', err);
    }
}

// Ejecutar
checkLogs();
