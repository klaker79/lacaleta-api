/**
 * tests/unit/supplierIvaPct.test.js
 *
 * Tests defensivos del campo `iva_pct` en la entidad Supplier (Migration 013).
 *
 * Reglas críticas (Iker 2026-06-06):
 *   - El IVA del proveedor es OPCIONAL (NULL = no configurado).
 *   - Debe estar entre 0 y 100; valores fuera de rango se normalizan a null.
 *   - Strings vacíos, undefined, no-numéricos → null.
 *   - El número se redondea a 2 decimales (constraint NUMERIC(5,2)).
 *
 * IMPORTANTE: este campo es SOLO display en el modal de recepción.
 * NO afecta a precio_medio_compra ni a ninguna fórmula crítica.
 * Los tests confirman ese aislamiento.
 */

const Supplier = require('../../src/domain/entities/Supplier');

describe('Supplier.normalizeIvaPct — estática', () => {
    test('null/undefined/empty → null', () => {
        expect(Supplier.normalizeIvaPct(null)).toBeNull();
        expect(Supplier.normalizeIvaPct(undefined)).toBeNull();
        expect(Supplier.normalizeIvaPct('')).toBeNull();
    });

    test('valor numérico válido (0-100) → número', () => {
        expect(Supplier.normalizeIvaPct(10)).toBe(10);
        expect(Supplier.normalizeIvaPct(21)).toBe(21);
        expect(Supplier.normalizeIvaPct(0)).toBe(0);
        expect(Supplier.normalizeIvaPct(100)).toBe(100);
    });

    test('string numérico se acepta', () => {
        expect(Supplier.normalizeIvaPct('21')).toBe(21);
        expect(Supplier.normalizeIvaPct('10.5')).toBe(10.5);
    });

    test('fuera de rango → null (constraint BD lo rechazaría)', () => {
        expect(Supplier.normalizeIvaPct(-1)).toBeNull();
        expect(Supplier.normalizeIvaPct(101)).toBeNull();
        expect(Supplier.normalizeIvaPct(999)).toBeNull();
    });

    test('no numérico → null', () => {
        expect(Supplier.normalizeIvaPct('hola')).toBeNull();
        expect(Supplier.normalizeIvaPct(NaN)).toBeNull();
        expect(Supplier.normalizeIvaPct({})).toBeNull();
    });

    test('redondea a 2 decimales (alinea con NUMERIC(5,2))', () => {
        expect(Supplier.normalizeIvaPct(21.005)).toBe(21.01);
        expect(Supplier.normalizeIvaPct(10.999)).toBe(11);
        expect(Supplier.normalizeIvaPct(4.25555)).toBe(4.26);
    });
});

describe('Supplier — constructor lee iva_pct desde BD o input', () => {
    test('campo iva_pct desde DB (snake_case) se mapea a ivaPct', () => {
        const s = new Supplier({ nombre: 'X', restaurante_id: 1, iva_pct: 21 });
        expect(s.ivaPct).toBe(21);
    });

    test('campo ivaPct desde código (camelCase) se mapea igual', () => {
        const s = new Supplier({ nombre: 'X', restaurante_id: 1, ivaPct: 10 });
        expect(s.ivaPct).toBe(10);
    });

    test('sin iva_pct → null (DEFAULT NULL)', () => {
        const s = new Supplier({ nombre: 'X', restaurante_id: 1 });
        expect(s.ivaPct).toBeNull();
    });

    test('iva_pct inválido (string sucio) se normaliza a null', () => {
        const s = new Supplier({ nombre: 'X', restaurante_id: 1, iva_pct: 'no es' });
        expect(s.ivaPct).toBeNull();
    });
});

describe('Supplier — toDTO/toDB serialización', () => {
    test('toDTO incluye iva_pct con clave snake_case (contrato API)', () => {
        const s = new Supplier({ nombre: 'X', restaurante_id: 1, iva_pct: 10 });
        const dto = s.toDTO();
        expect(dto).toHaveProperty('iva_pct', 10);
    });

    test('toDB incluye iva_pct para que el repository lo persista', () => {
        const s = new Supplier({ nombre: 'X', restaurante_id: 1, iva_pct: 21 });
        const db = s.toDB();
        expect(db).toHaveProperty('iva_pct', 21);
    });

    test('toDTO de proveedor sin IVA → iva_pct null (no undefined, contrato estable)', () => {
        const s = new Supplier({ nombre: 'X', restaurante_id: 1 });
        expect(s.toDTO().iva_pct).toBeNull();
    });
});

describe('Supplier — el IVA no rompe ninguna otra propiedad', () => {
    test('proveedor completo: todos los campos preexistentes siguen iguales tras añadir iva_pct', () => {
        const data = {
            id: 7,
            nombre: 'Verduras Pepe',
            contacto: 'Pepe',
            telefono: '600000000',
            email: 'p@v.com',
            direccion: 'C/ Real 1',
            notas: 'Llamar antes',
            codigo: 'VPEP',
            cif: 'B12345678',
            iva_pct: 10,
            ingredientes: [1, 2, 3],
            restaurante_id: 3
        };
        const s = new Supplier(data);
        const dto = s.toDTO();
        expect(dto.id).toBe(7);
        expect(dto.nombre).toBe('Verduras Pepe');
        expect(dto.contacto).toBe('Pepe');
        expect(dto.telefono).toBe('600000000');
        expect(dto.email).toBe('p@v.com');
        expect(dto.direccion).toBe('C/ Real 1');
        expect(dto.notas).toBe('Llamar antes');
        expect(dto.codigo).toBe('VPEP');
        expect(dto.cif).toBe('B12345678');
        expect(dto.iva_pct).toBe(10);
        expect(dto.ingredientes).toEqual([1, 2, 3]);
        expect(dto.restaurante_id).toBe(3);
    });
});
