/**
 * Entidad de dominio: Supplier (Proveedor)
 *
 * Campos de la tabla proveedores:
 * - id, nombre, contacto, telefono, email, direccion, notas
 * - codigo, cif, iva_pct, ingredientes[], restaurante_id
 * - created_at, fecha_actualizacion, deleted_at
 *
 * iva_pct (Migration 013, 2026-06-06): IVA habitual del proveedor.
 * SOLO display en el modal de recepción para cuadrar con el albarán.
 * NO afecta a precio_medio_compra ni a ninguna fórmula crítica.
 */

class Supplier {
    constructor(data) {
        this.id = data.id;
        this.restaurantId = data.restaurante_id || data.restaurantId;
        this.name = data.nombre || data.name;
        this.contact = data.contacto || data.contact || '';
        this.phone = data.telefono || data.phone || '';
        this.email = data.email || '';
        this.address = data.direccion || data.address || '';
        this.notes = data.notas || data.notes || '';
        this.code = data.codigo || data.code || '';
        this.cif = data.cif || '';
        // IVA habitual del proveedor en porcentaje (0-100) o null si no configurado.
        // Se normaliza a número o null para evitar strings sucios del cliente.
        this.ivaPct = Supplier.normalizeIvaPct(data.iva_pct ?? data.ivaPct);
        this.ingredientIds = data.ingredientes || data.ingredientIds || [];
        this.createdAt = data.created_at || data.createdAt;
        this.updatedAt = data.fecha_actualizacion || data.updatedAt;
        this.deletedAt = data.deleted_at || data.deletedAt;
    }

    /**
     * Convierte el valor de IVA a número 0-100 o null. Rechaza valores
     * fuera de rango para que el constraint de BD no salte.
     */
    static normalizeIvaPct(value) {
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        if (n < 0 || n > 100) return null;
        // Redondear a 2 decimales para que coincida con NUMERIC(5,2)
        return Math.round(n * 100) / 100;
    }

    /**
     * Verifica si el proveedor tiene un ingrediente específico
     */
    hasIngredient(ingredientId) {
        return this.ingredientIds.includes(ingredientId);
    }

    /**
     * Agrega un ingrediente al proveedor
     */
    addIngredient(ingredientId) {
        if (!this.hasIngredient(ingredientId)) {
            this.ingredientIds.push(ingredientId);
        }
    }

    /**
     * Remueve un ingrediente del proveedor
     */
    removeIngredient(ingredientId) {
        this.ingredientIds = this.ingredientIds.filter(id => id !== ingredientId);
    }

    /**
     * Verifica si el proveedor está activo (no eliminado)
     */
    isActive() {
        return !this.deletedAt;
    }

    /**
     * Verifica si tiene información de contacto completa
     */
    hasCompleteContactInfo() {
        return !!(this.phone || this.email);
    }

    /**
     * Convierte a DTO para respuestas HTTP
     */
    toDTO() {
        return {
            id: this.id,
            nombre: this.name,
            contacto: this.contact,
            telefono: this.phone,
            email: this.email,
            direccion: this.address,
            notas: this.notes,
            codigo: this.code,
            cif: this.cif,
            iva_pct: this.ivaPct,
            ingredientes: this.ingredientIds,
            restaurante_id: this.restaurantId
        };
    }

    /**
     * Convierte a formato de base de datos
     */
    toDB() {
        return {
            nombre: this.name,
            contacto: this.contact,
            telefono: this.phone,
            email: this.email,
            direccion: this.address,
            notas: this.notes,
            codigo: this.code,
            cif: this.cif,
            iva_pct: this.ivaPct,
            ingredientes: this.ingredientIds,
            restaurante_id: this.restaurantId
        };
    }
}

module.exports = Supplier;
