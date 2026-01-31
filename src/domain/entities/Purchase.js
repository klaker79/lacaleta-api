/**
 * Entidad de dominio: Purchase (Pedido a proveedor)
 * 
 * Campos de la tabla pedidos:
 * - id, proveedor_id, fecha, ingredientes (JSONB), total
 * - estado, fecha_creacion, fecha_recepcion, total_recibido
 * - restaurante_id
 */

class Purchase {
    // Estados posibles del pedido
    static STATUS = {
        PENDING: 'pendiente',
        SENT: 'enviado',
        RECEIVED: 'recibido',
        CANCELLED: 'cancelado'
    };

    constructor(data) {
        this.id = data.id;
        this.restaurantId = data.restaurante_id || data.restaurantId;
        this.supplierId = data.proveedor_id || data.supplierId;
        this.date = data.fecha || data.date;
        this.items = this._parseItems(data.ingredientes || data.items);
        this.total = parseFloat(data.total) || 0;
        this.status = data.estado || data.status || Purchase.STATUS.PENDING;
        this.createdAt = data.fecha_creacion || data.createdAt;
        this.receivedAt = data.fecha_recepcion || data.receivedAt;
        this.totalReceived = data.total_recibido ? parseFloat(data.total_recibido) : null;
    }

    /**
     * Parsea los items del pedido (vienen como JSONB)
     */
    _parseItems(items) {
        if (!items) return [];
        if (typeof items === 'string') {
            try {
                return JSON.parse(items);
            } catch {
                return [];
            }
        }
        return Array.isArray(items) ? items : [];
    }

    /**
     * Verifica si el pedido está pendiente
     */
    isPending() {
        return this.status === Purchase.STATUS.PENDING;
    }

    /**
     * Verifica si el pedido fue recibido
     */
    isReceived() {
        return this.status === Purchase.STATUS.RECEIVED;
    }

    /**
     * Verifica si el pedido está cancelado
     */
    isCancelled() {
        return this.status === Purchase.STATUS.CANCELLED;
    }

    /**
     * Verifica si se puede modificar el pedido
     */
    canBeModified() {
        return this.isPending();
    }

    /**
     * Verifica si se puede recibir el pedido
     */
    canBeReceived() {
        return this.status === Purchase.STATUS.PENDING ||
            this.status === Purchase.STATUS.SENT;
    }

    /**
     * Calcula el número de items en el pedido
     */
    getItemCount() {
        return this.items.length;
    }

    /**
     * Calcula la diferencia entre total pedido y total recibido
     */
    getDiscrepancy() {
        if (this.totalReceived === null) return null;
        return this.total - this.totalReceived;
    }

    /**
     * Verifica si hay discrepancia en el pedido recibido
     */
    hasDiscrepancy() {
        const discrepancy = this.getDiscrepancy();
        return discrepancy !== null && Math.abs(discrepancy) > 0.01;
    }

    /**
     * Marca el pedido como recibido
     */
    markAsReceived(totalReceived) {
        this.status = Purchase.STATUS.RECEIVED;
        this.receivedAt = new Date();
        this.totalReceived = parseFloat(totalReceived);
    }

    /**
     * Marca el pedido como enviado
     */
    markAsSent() {
        if (this.isPending()) {
            this.status = Purchase.STATUS.SENT;
        }
    }

    /**
     * Cancela el pedido
     */
    cancel() {
        if (this.canBeModified()) {
            this.status = Purchase.STATUS.CANCELLED;
        }
    }

    /**
     * Convierte a DTO para respuestas HTTP
     */
    toDTO() {
        return {
            id: this.id,
            supplierId: this.supplierId,
            date: this.date,
            items: this.items,
            total: this.total,
            status: this.status,
            createdAt: this.createdAt,
            receivedAt: this.receivedAt,
            totalReceived: this.totalReceived,
            itemCount: this.getItemCount(),
            isPending: this.isPending(),
            isReceived: this.isReceived(),
            hasDiscrepancy: this.hasDiscrepancy(),
            discrepancy: this.getDiscrepancy()
        };
    }

    /**
     * Convierte a formato de base de datos
     */
    toDB() {
        return {
            proveedor_id: this.supplierId,
            fecha: this.date,
            ingredientes: JSON.stringify(this.items),
            total: this.total,
            estado: this.status,
            fecha_recepcion: this.receivedAt,
            total_recibido: this.totalReceived,
            restaurante_id: this.restaurantId
        };
    }
}

module.exports = Purchase;
