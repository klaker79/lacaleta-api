/**
 * GUARD — la promoción de "grandfathering" a premium en init.js DEBE llevar un
 * cutoff por fecha (`created_at < '...'`).
 *
 * Incidente 2026-06-29: la migración hacía
 *   UPDATE restaurantes SET plan='premium', plan_status='active' WHERE plan='trial';
 * SIN cutoff, y corre en CADA arranque del backend → tras el primer redeploy
 * re-promocionaba a premium/active a TODO registro nuevo en trial. Resultado: el
 * trial nunca caducaba (el gating solo mira trial_ends_at cuando plan='trial') →
 * dinero perdido. El fix añadió `AND created_at < '2026-05-20'` para grandfatherear
 * SOLO a los legacy pre-paywall.
 *
 * Este test (estático, sin servidor) impide que alguien quite el cutoff y reabra el
 * agujero. Si falla: la promoción a premium sobre trials DEBE acotar por created_at.
 */
const fs = require('fs');
const path = require('path');

const INIT = path.join(__dirname, '..', '..', 'src', 'db', 'init.js');

describe('GUARD trial — la promoción a premium NUNCA re-promociona trials nuevos', () => {
    it("todo UPDATE que pone plan='premium' sobre plan='trial' incluye cutoff created_at <", () => {
        const texto = fs.readFileSync(INIT, 'utf8');

        // UPDATEs sobre restaurantes que asignan plan='premium'. El SQL vive en un
        // template literal y termina en ';' → [^;]* acota la sentencia.
        const regex = /UPDATE\s+restaurantes\s+SET[^;]*?plan\s*=\s*'premium'[^;]*?WHERE([^;]*)/gis;
        const infracciones = [];
        let m;
        while ((m = regex.exec(texto)) !== null) {
            const whereClause = m[1];
            // Solo nos importa si la promoción toca a los trials.
            const tocaTrials = /plan\s*=\s*'trial'/i.test(whereClause);
            const tieneCutoff = /created_at\s*<\s*'/i.test(whereClause);
            if (tocaTrials && !tieneCutoff) {
                const linea = texto.slice(0, m.index).split('\n').length;
                infracciones.push(
                    `init.js:${linea}  →  UPDATE ... plan='premium' WHERE plan='trial' SIN "created_at < '...'"`
                );
            }
        }

        if (infracciones.length > 0) {
            throw new Error(
                'Promoción de grandfathering SIN cutoff por fecha. Re-promocionaría a premium\n' +
                'a TODO trial nuevo en cada arranque → el trial no caduca (dinero perdido).\n' +
                'Añade `AND created_at < \'<fecha go-live>\'` al WHERE:\n  ' +
                infracciones.join('\n  ')
            );
        }
        expect(infracciones).toHaveLength(0);
    });

    it('el cutoff actual sigue presente (sanity check del fix)', () => {
        const texto = fs.readFileSync(INIT, 'utf8');
        // El fix concreto: la promoción a premium acota por created_at < '2026-05-20'.
        expect(texto).toMatch(/plan\s*=\s*'trial'\s+AND\s+created_at\s*<\s*'2026-05-20'/i);
    });
});
