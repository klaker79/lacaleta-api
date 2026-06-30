/**
 * GUARD — las tools de Omnes (chatService.js) DEBEN ser SOLO-LECTURA.
 *
 * El muro de seguridad real del chat no es el system prompt (un LLM puede ser
 * "convencido"), son las TOOLS: si solo pueden LEER y van filtradas por
 * restaurante_id, el peor jailbreak posible es que Omnes diga una tontería —
 * NUNCA modificar/borrar datos ni tocar otro tenant.
 *
 * Cualquier modificación de datos debe ir por el flujo [ACTION:...] → el frontend
 * muestra el modal "Aplicar cambio / Cancelar" (chat-action-preview.js) → ejecuta
 * contra los endpoints autenticados (tenant-scoped, validados). NUNCA escribir
 * directamente desde chatService.js, porque eso se saltaría la confirmación.
 *
 * Este guard falla si aparece un UPDATE / INSERT / DELETE en chatService.js.
 * Auditoría de seguridad de Omnes 2026-06-30 (a raíz del vídeo de Chema Alonso
 * sobre hacking de asistentes IA).
 */
const fs = require('fs');
const path = require('path');

const CHAT_SERVICE = path.join(__dirname, '..', '..', 'src', 'services', 'chatService.js');

describe('GUARD Omnes — las tools del chat son SOLO-LECTURA', () => {
    it('chatService.js NO contiene escrituras SQL (UPDATE / INSERT INTO / DELETE FROM)', () => {
        const texto = fs.readFileSync(CHAT_SERVICE, 'utf8');

        // Quitar comentarios de línea y de bloque para no falsear con texto explicativo.
        const sinComentarios = texto
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n')
            .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
            .join('\n');

        const regex = /\b(UPDATE\s+\w|INSERT\s+INTO|DELETE\s+FROM)\b/gi;
        const infracciones = [];
        let m;
        while ((m = regex.exec(sinComentarios)) !== null) {
            const linea = sinComentarios.slice(0, m.index).split('\n').length;
            infracciones.push(`chatService.js:~${linea}  →  "${m[0]}"`);
        }

        if (infracciones.length > 0) {
            throw new Error(
                'chatService.js contiene ESCRITURAS SQL. Las tools de Omnes deben ser solo-lectura;\n' +
                'toda modificación va por [ACTION:...] → confirmación del usuario → endpoint autenticado.\n' +
                'Escribir desde el chat se saltaría la confirmación:\n  ' +
                infracciones.join('\n  ')
            );
        }
        expect(infracciones).toHaveLength(0);
    });

    it('el filtro anti-inyección y sus patrones siguen presentes (sanity)', () => {
        const texto = fs.readFileSync(CHAT_SERVICE, 'utf8');
        expect(texto).toMatch(/function detectarIntentoInjection/);
        expect(texto).toMatch(/INJECTION_PATTERNS\s*=\s*\[/);
        // Se aplica al mensaje actual (no solo al historial).
        expect(texto).toMatch(/detectarIntentoInjection\(message\)/);
    });
});
