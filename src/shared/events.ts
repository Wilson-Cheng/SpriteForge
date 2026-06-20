// src/shared/events.ts
// Tiny event bus for editor-wide notifications. We don't need a full pub-sub
// framework — a Map<eventName, Set<callback>> is plenty for P1.

export type Listener<T = unknown> = (payload: T) => void;

export class EventBus {
  private listeners = new Map<string, Set<Listener<unknown>>>();

  on<T = unknown>(event: string, cb: Listener<T>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as Listener<unknown>);
    return () => this.off(event, cb);
  }

  off<T = unknown>(event: string, cb: Listener<T>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(cb as Listener<unknown>);
  }

  emit<T = unknown>(event: string, payload?: T): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try { (cb as Listener<T>)(payload as T); }
      catch (e) { console.error(`[bus] listener for "${event}" threw`, e); }
    }
  }
}
