// services/eventEmitter.ts

type Listener = (...args: any[]) => void;

export class EventEmitter {
    private events: Record<string, Listener[]> = {};

    on(eventName: string, listener: Listener) {
        if (!this.events[eventName]) {
            this.events[eventName] = [];
        }
        this.events[eventName].push(listener);
    }

    off(eventName: string, listener: Listener) {
        if (!this.events[eventName]) {
            return;
        }
        this.events[eventName] = this.events[eventName].filter(l => l !== listener);
    }

    emit(eventName: string, ...args: any[]) {
        if (!this.events[eventName]) {
            return;
        }
        this.events[eventName].forEach(listener => {
            try {
                listener(...args);
            } catch (error) {
                console.error(`Error in event listener for ${eventName}:`, error);
            }
        });
    }
}
