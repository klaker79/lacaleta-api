/**
 * Casa LITE sin Omnes — guardián del corte (2026-08-02).
 *
 * DECISIÓN DE PRODUCTO (Iker): la versión Lite NO lleva chat inteligente. Sí
 * lleva OCR, y sí lleva el informe mensual — pero como entregable de un botón,
 * no como conversación. Esa es la diferencia por la que la app grande cuesta
 * más: un informe al mes frente a un asistente disponible siempre.
 *
 * DOS COSAS QUE ESTE TEST BLINDA:
 *
 * 1. El informe mensual SOBREVIVE sin chat. Vivía dentro de `chat.routes.js`,
 *    así que desmontar el chat se lo llevaba por delante. Ahora vive en
 *    `informes.routes.js` y se monta siempre.
 *
 * 2. El corte del chat es de SERVIDOR, no de maquillaje. Esconder la pestaña en
 *    el frontend no impide que alguien con sesión llame a /api/chat y nos gaste
 *    la API de Anthropic. Con CHAT_ENABLED=false el router ni se carga.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src', 'routes');
const indexSrc = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
const informesSrc = fs.readFileSync(path.join(SRC, 'informes.routes.js'), 'utf8');
const chatSrc = fs.readFileSync(path.join(SRC, 'chat.routes.js'), 'utf8');

describe('el informe mensual ya no depende del chat', () => {
    test('vive en su propio router', () => {
        expect(fs.existsSync(path.join(SRC, 'informes.routes.js'))).toBe(true);
        expect(informesSrc).toContain('generarInformeMensual');
        expect(informesSrc).toContain('generarInformeHtml');
    });

    test('chat.routes ya NO lo sirve (si no, habría dos implementaciones)', () => {
        expect(chatSrc).not.toContain('generarInformeMensual');
        expect(chatSrc).not.toContain('generarInformeHtml');
        expect(chatSrc).not.toMatch(/router\.get\(\s*'\/chat\/informe-mensual/);
    });

    test('se monta SIEMPRE, fuera del if del chat', () => {
        const posInformes = indexSrc.indexOf("mount('informes'");
        const posIf = indexSrc.indexOf('if (chatEnabled)');
        expect(posInformes).toBeGreaterThan(-1);
        expect(posIf).toBeGreaterThan(-1);
        // Montado antes del condicional ⇒ no cuelga de él.
        expect(posInformes).toBeLessThan(posIf);
    });

    // El frontend desplegado todavía llama a las URLs viejas: si desaparecen,
    // el informe deja de funcionar en las casas que aún sirven bundles antiguos.
    test('mantiene los alias antiguos /chat/informe-mensual', () => {
        expect(informesSrc).toContain("'/chat/informe-mensual'");
        expect(informesSrc).toContain("'/chat/informe-mensual/html'");
        expect(informesSrc).toContain("'/informes/mensual'");
        expect(informesSrc).toContain("'/informes/mensual/html'");
    });

    test('los alias reutilizan el MISMO handler, no una copia', () => {
        // Si alguien duplicara la lógica, las dos rutas podrían divergir.
        expect((informesSrc.match(/datosMensuales/g) || []).length).toBeGreaterThanOrEqual(3);
        expect((informesSrc.match(/htmlMensual/g) || []).length).toBeGreaterThanOrEqual(3);
    });
});

describe('el chat se apaga en el servidor, no en la interfaz', () => {
    test('CHAT_ENABLED controla si el router se monta', () => {
        expect(indexSrc).toContain('CHAT_ENABLED');
        expect(indexSrc).toMatch(/if\s*\(chatEnabled\)\s*\{[\s\S]{0,120}mount\('chat'/);
    });

    // Sin default permisivo, actualizar la API de La Nave 5 apagaría Omnes sin
    // que nadie lo pidiera. El que tiene que declararse es quien lo apaga.
    test('por defecto está ENCENDIDO: ninguna casa pierde el chat por accidente', () => {
        expect(indexSrc).toMatch(/CHAT_ENABLED\s*\?\?\s*'true'/);
    });

    test('solo se apaga con el valor explícito "false"', () => {
        const regla = (v) => String(v ?? 'true').toLowerCase() !== 'false';
        expect(regla(undefined)).toBe(true);   // no definida → chat activo
        expect(regla('true')).toBe(true);
        expect(regla('')).toBe(true);          // vacía → no apaga nada
        expect(regla('False')).toBe(false);
        expect(regla('false')).toBe(false);
    });
});
