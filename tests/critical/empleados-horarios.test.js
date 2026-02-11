/**
 * ═══════════════════════════════════════════════════
 * 👥 EMPLEADOS + HORARIOS — Staff and schedule lifecycle
 * ═══════════════════════════════════════════════════
 * Tests:
 * 1. POST /api/empleados — creates employee
 * 2. GET /api/empleados — lists the created employee
 * 3. PUT /api/empleados/:id — updates employee
 * 4. POST /api/horarios — assigns shift to employee
 * 5. GET /api/horarios — lists assigned shift
 * 6. DELETE /api/horarios/:id — removes shift
 * 7. DELETE /api/empleados/:id — soft deletes employee
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Empleados + Horarios — Staff and schedule lifecycle', () => {
    let authToken;
    let createdEmpleadoId;
    let createdHorarioId;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    afterAll(async () => {
        if (!authToken) return;
        // Cleanup shift
        if (createdHorarioId) {
            await request(API_URL)
                .delete(`/api/horarios/${createdHorarioId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
        // Cleanup employee
        if (createdEmpleadoId) {
            await request(API_URL)
                .delete(`/api/empleados/${createdEmpleadoId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            console.log(`🗑️ Cleaned up empleado ${createdEmpleadoId}`);
        }
    });

    it('1. POST /api/empleados — creates employee', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/empleados')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: '_TEST_EMPLEADO_' + Date.now(),
                puesto: 'Cocinero',
                horas_contrato: 35,
                coste_hora: 12.50,
                color: '#FF5733'
            });

        expect(res.status).toBe(201);
        expect(res.body.id).toBeDefined();
        expect(res.body.nombre).toContain('_TEST_EMPLEADO_');
        expect(res.body.puesto).toBe('Cocinero');

        createdEmpleadoId = res.body.id;
        console.log(`✅ Created empleado #${createdEmpleadoId}: ${res.body.nombre}`);
    });

    it('2. GET /api/empleados — lists the created employee', async () => {
        if (!authToken || !createdEmpleadoId) return;

        const res = await request(API_URL)
            .get('/api/empleados')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        const found = res.body.find(e => e.id === createdEmpleadoId);
        expect(found).toBeDefined();
        console.log(`✅ Found empleado in list (${res.body.length} total)`);
    });

    it('3. PUT /api/empleados/:id — updates employee', async () => {
        if (!authToken || !createdEmpleadoId) return;

        const res = await request(API_URL)
            .put(`/api/empleados/${createdEmpleadoId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ puesto: 'Jefe de Cocina', coste_hora: 15 });

        expect(res.status).toBe(200);
        expect(res.body.puesto).toBe('Jefe de Cocina');
        console.log(`✅ Updated empleado: puesto → ${res.body.puesto}`);
    });

    it('4. POST /api/horarios — assigns shift to employee', async () => {
        if (!authToken || !createdEmpleadoId) return;

        // Use a future date to avoid conflicts with existing shifts
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + 30);
        const fechaStr = futureDate.toISOString().split('T')[0];

        const res = await request(API_URL)
            .post('/api/horarios')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                empleado_id: createdEmpleadoId,
                fecha: fechaStr,
                turno: 'mañana',
                hora_inicio: '09:00',
                hora_fin: '17:00'
            });

        expect(res.status).toBe(201);
        expect(res.body.id).toBeDefined();

        createdHorarioId = res.body.id;
        console.log(`✅ Assigned shift #${createdHorarioId} for ${fechaStr}`);
    });

    it('5. GET /api/horarios — lists assigned shift', async () => {
        if (!authToken || !createdHorarioId) return;

        // The endpoint requires desde/hasta date range
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + 30);
        const desde = new Date(futureDate);
        desde.setDate(desde.getDate() - 1);
        const hasta = new Date(futureDate);
        hasta.setDate(hasta.getDate() + 1);

        const res = await request(API_URL)
            .get(`/api/horarios?desde=${desde.toISOString().split('T')[0]}&hasta=${hasta.toISOString().split('T')[0]}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        const found = res.body.find(h => h.id === createdHorarioId);
        expect(found).toBeDefined();
        console.log(`✅ Found shift in horarios list`);
    });

    it('6. DELETE /api/horarios/:id — removes shift', async () => {
        if (!authToken || !createdHorarioId) return;

        const res = await request(API_URL)
            .delete(`/api/horarios/${createdHorarioId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        console.log(`✅ Shift deleted`);
        createdHorarioId = null;
    });

    it('7. DELETE /api/empleados/:id — soft deletes employee', async () => {
        if (!authToken || !createdEmpleadoId) return;

        const deleteRes = await request(API_URL)
            .delete(`/api/empleados/${createdEmpleadoId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(deleteRes.status).toBe(200);

        // Verify not in active list
        const listRes = await request(API_URL)
            .get('/api/empleados')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        const found = listRes.body.find(e => e.id === createdEmpleadoId);
        expect(found).toBeUndefined();
        console.log(`✅ Employee soft-deleted, no longer in active list`);
        createdEmpleadoId = null;
    });
});
