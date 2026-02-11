/**
 * ═══════════════════════════════════════════════════
 * 📅 HORARIOS ADVANCED — Copy week + toggle by date
 * ═══════════════════════════════════════════════════
 * Tests:
 * 1. POST /api/horarios/copiar-semana — copy week schedule
 * 2. POST /api/horarios/copiar-semana without required fields → 400
 * 3. DELETE /api/horarios/empleado/:id/fecha/:fecha — toggle shift by date
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Horarios Advanced — Copy week and toggle operations', () => {
    let authToken;
    let testEmpleadoId;
    let createdShiftId;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        // Create a test employee for shift operations
        const res = await request(API_URL)
            .post('/api/empleados')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: '_TEST_HORARIO_ADV_' + Date.now(),
                puesto: 'Camarero',
                horas_contrato: 40,
                coste_hora: 10
            });

        if (res.status === 201) {
            testEmpleadoId = res.body.id;
            console.log(`📝 Created test employee #${testEmpleadoId}`);

            // Create a shift for the toggle test (far future to avoid conflicts)
            const futureDate = new Date();
            futureDate.setDate(futureDate.getDate() + 60);
            const fechaStr = futureDate.toISOString().split('T')[0];

            const shiftRes = await request(API_URL)
                .post('/api/horarios')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    empleado_id: testEmpleadoId,
                    fecha: fechaStr,
                    turno: 'mañana',
                    hora_inicio: '08:00',
                    hora_fin: '16:00'
                });

            if (shiftRes.status === 201) {
                createdShiftId = shiftRes.body.id;
                console.log(`📅 Created test shift #${createdShiftId} for ${fechaStr}`);
            }
        }
    });

    afterAll(async () => {
        if (!authToken) return;
        if (createdShiftId) {
            await request(API_URL)
                .delete(`/api/horarios/${createdShiftId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
        if (testEmpleadoId) {
            await request(API_URL)
                .delete(`/api/empleados/${testEmpleadoId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            console.log(`🗑️ Cleaned up employee #${testEmpleadoId}`);
        }
    });

    it('1. POST /api/horarios/copiar-semana without required fields → 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/horarios/copiar-semana')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({}); // Missing semana_origen and semana_destino

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
        console.log(`✅ Missing fields → ${res.status}: ${res.body.error}`);
    });

    it('2. POST /api/horarios/copiar-semana — copy week (may copy 0 if source empty)', async () => {
        if (!authToken) return;

        // Use two far-future weeks that are guaranteed empty
        const sourceDate = new Date();
        sourceDate.setDate(sourceDate.getDate() + 90);
        // Align to Monday
        const dayOfWeek = sourceDate.getDay();
        sourceDate.setDate(sourceDate.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));

        const destDate = new Date(sourceDate);
        destDate.setDate(destDate.getDate() + 7);

        const res = await request(API_URL)
            .post('/api/horarios/copiar-semana')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                semana_origen: sourceDate.toISOString().split('T')[0],
                semana_destino: destDate.toISOString().split('T')[0]
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.turnos_copiados).toBeDefined();
        console.log(`✅ Copy week: ${res.body.turnos_copiados} shifts copied`);
    });

    it('3. DELETE /api/horarios/empleado/:id/fecha/:fecha — toggle shift by date', async () => {
        if (!authToken || !testEmpleadoId) return;

        // Use the date we created the shift for
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + 60);
        const fechaStr = futureDate.toISOString().split('T')[0];

        const res = await request(API_URL)
            .delete(`/api/horarios/empleado/${testEmpleadoId}/fecha/${fechaStr}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        console.log(`✅ Toggle shift deleted for employee #${testEmpleadoId} on ${fechaStr}`);
        createdShiftId = null; // Already deleted by toggle
    });
});
