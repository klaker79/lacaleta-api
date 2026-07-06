// Contrato del prompt de Omnes — NO testea la salida del LLM (eso no es
// determinista), sino que BLINDA que las reglas de seguridad sigan PRESENTES en
// el prompt. Un prompt tan grande se edita a menudo; sin este test, un refactor
// podría borrar sin querer una regla crítica y reabrir un fallo ya cerrado.
//
// Incidentes que blinda (2026-07-06):
//   1. Omnes llamaba "error de captura" a una variación de precio real.
//   2. Omnes ofrecía "actualizar" un albarán histórico que no puede tocar.
const { SYSTEM_PROMPT_STATIC } = require('../../src/services/chatService');

const P = SYSTEM_PROMPT_STATIC;

describe('Omnes — guardarraíles del prompt (contrato de seguridad)', () => {
    test('el tool expone variación vs incoherencia por separado', () => {
        expect(P).toContain('variaciones_precio_altas');
        expect(P).toContain('datos_incoherentes');
    });

    test('regla: una variación de precio NO es un error', () => {
        expect(P).toContain('NO es un error');
    });

    test('regla: nunca recomendar tocar el albarán por una variación', () => {
        expect(P).toContain('modificar/corregir/borrar el albarán');
    });

    test('regla: no ofrecer editar un albarán/pedido histórico (no hay acción)', () => {
        expect(P).toContain('no existe ninguna acción para');
        expect(P).toContain('NUNCA ofrezcas hacerlo');
    });
});
