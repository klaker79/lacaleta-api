/**
 * Event Bus interno
 * Comunicación desacoplada entre módulos
 * Preparado para migración futura a Redis/Kafka
 */

class EventBus {
    constructor() {
        this.handlers = new Map();
        this.history = [];
        this.maxHistory = 100;
    }

    /**
     * Suscribe un handler a un tipo de evento
     * @param {string} eventType
     * @param {Function} handler
     * @returns {Function} Función para desuscribirse
     */
    subscribe(eventType, handler) {
        if (!this.handlers.has(eventType)) {
            this.handlers.set(eventType, []);
        }
        this.handlers.get(eventType).push(handler);

        // Retornar función de unsuscribe
        return () => {
            const handlers = this.handlers.get(eventType);
            const index = handlers.indexOf(handler);
            if (index > -1) {
                handlers.splice(index, 1);
            }
        };
    }

    /**
     * Emite un evento
     * @param {Object} event - { type, payload, timestamp }
     */
    async emit(event) {
        const eventType = event.type;
        const handlers = this.handlers.get(eventType) || [];

        // Log del evento
        console.log(`[EventBus] Emitting ${eventType}:`, JSON.stringify(event.payload));

        // Guardar en historial
        this.addToHistory(event);

        // Ejecutar handlers
        const results = await Promise.allSettled(
            handlers.map(handler => this.executeHandler(handler, event))
        );

        // Log de errores
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                console.error(`[EventBus] Handler ${index} failed for ${eventType}:`, result.reason);
            }
        });

        return results;
    }

    /**
     * Ejecuta un handler con timeout
     * @private
     */
    async executeHandler(handler, event) {
        const timeout = 5000; // 5 segundos máximo por handler

        return Promise.race([
            handler(event),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Handler timeout')), timeout)
            )
        ]);
    }

    /**
     * Añade evento al historial
     * @private
     */
    addToHistory(event) {
        this.history.push({
            ...event,
            processedAt: new Date()
        });

        // Limitar tamaño del historial
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }
    }

    /**
     * Obtiene historial de eventos
     */
    getHistory(eventType = null, limit = 20) {
        let filtered = this.history;

        if (eventType) {
            filtered = filtered.filter(e => e.type === eventType);
        }

        return filtered.slice(-limit);
    }

    /**
     * Limpia todos los handlers (útil para tests)
     */
    clear() {
        this.handlers.clear();
        this.history = [];
    }
}

// Singleton
const eventBus = new EventBus();

module.exports = eventBus;
