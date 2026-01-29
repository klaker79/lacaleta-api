/**
 * Tests: EventBus
 */

// Importar el módulo directamente (no el singleton)
const EventBusModule = require('../../src/shared/events/EventBus');

describe('EventBus', () => {
    let eventBus;

    beforeEach(() => {
        // Usar el singleton pero limpiar entre tests
        eventBus = EventBusModule;
        eventBus.clear();
    });

    afterEach(() => {
        eventBus.clear();
    });

    describe('subscribe', () => {
        it('should register handler for event type', () => {
            const handler = jest.fn();
            eventBus.subscribe('test.event', handler);

            expect(eventBus.handlers.has('test.event')).toBe(true);
        });

        it('should return unsubscribe function', () => {
            const handler = jest.fn();
            const unsubscribe = eventBus.subscribe('test.event', handler);

            unsubscribe();

            expect(eventBus.handlers.get('test.event')).toHaveLength(0);
        });

        it('should allow multiple handlers for same event', () => {
            const handler1 = jest.fn();
            const handler2 = jest.fn();

            eventBus.subscribe('test.event', handler1);
            eventBus.subscribe('test.event', handler2);

            expect(eventBus.handlers.get('test.event')).toHaveLength(2);
        });
    });

    describe('emit', () => {
        it('should call all registered handlers', async () => {
            const handler1 = jest.fn();
            const handler2 = jest.fn();

            eventBus.subscribe('test.event', handler1);
            eventBus.subscribe('test.event', handler2);

            await eventBus.emit({
                type: 'test.event',
                payload: { data: 'test' },
                timestamp: new Date()
            });

            expect(handler1).toHaveBeenCalled();
            expect(handler2).toHaveBeenCalled();
        });

        it('should pass event to handlers', async () => {
            const handler = jest.fn();
            eventBus.subscribe('test.event', handler);

            const event = {
                type: 'test.event',
                payload: { id: 123 },
                timestamp: new Date()
            };

            await eventBus.emit(event);

            expect(handler).toHaveBeenCalledWith(event);
        });

        it('should continue if one handler fails', async () => {
            const failingHandler = jest.fn().mockRejectedValue(new Error('Failed'));
            const successHandler = jest.fn();

            eventBus.subscribe('test.event', failingHandler);
            eventBus.subscribe('test.event', successHandler);

            await eventBus.emit({
                type: 'test.event',
                payload: {},
                timestamp: new Date()
            });

            expect(successHandler).toHaveBeenCalled();
        });

        it('should add events to history', async () => {
            await eventBus.emit({
                type: 'test.event',
                payload: { id: 1 },
                timestamp: new Date()
            });

            const history = eventBus.getHistory();
            expect(history).toHaveLength(1);
            expect(history[0].type).toBe('test.event');
        });

        it('should not call handlers for different event types', async () => {
            const handler = jest.fn();
            eventBus.subscribe('other.event', handler);

            await eventBus.emit({
                type: 'test.event',
                payload: {},
                timestamp: new Date()
            });

            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe('getHistory', () => {
        it('should filter by event type', async () => {
            await eventBus.emit({ type: 'type.a', payload: {}, timestamp: new Date() });
            await eventBus.emit({ type: 'type.b', payload: {}, timestamp: new Date() });
            await eventBus.emit({ type: 'type.a', payload: {}, timestamp: new Date() });

            const history = eventBus.getHistory('type.a');
            expect(history).toHaveLength(2);
        });

        it('should limit results', async () => {
            for (let i = 0; i < 10; i++) {
                await eventBus.emit({ type: 'test', payload: { i }, timestamp: new Date() });
            }

            const history = eventBus.getHistory(null, 5);
            expect(history).toHaveLength(5);
        });

        it('should return all events when no filter', async () => {
            await eventBus.emit({ type: 'type.a', payload: {}, timestamp: new Date() });
            await eventBus.emit({ type: 'type.b', payload: {}, timestamp: new Date() });

            const history = eventBus.getHistory();
            expect(history).toHaveLength(2);
        });
    });

    describe('clear', () => {
        it('should remove all handlers and history', async () => {
            eventBus.subscribe('test', jest.fn());
            await eventBus.emit({ type: 'test', payload: {}, timestamp: new Date() });

            eventBus.clear();

            expect(eventBus.handlers.size).toBe(0);
            expect(eventBus.history).toHaveLength(0);
        });
    });
});
