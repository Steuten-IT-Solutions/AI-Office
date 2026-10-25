import type { StoredEvent } from "./event-store.ts";

/**
 * Bekannte Ereignistypen. Unbekannte Typen und neuere Schemaversionen werden gespeichert und
 * beim Lesen übersprungen (plan.md Kap. 4.5 Nr. 7, E24). So kann eine ältere Office-Version die
 * Ereignisse einer neueren lesen, ohne abzustürzen.
 */
export interface EventType<T> {
  type: string;
  /** Höchste Schemaversion, die dieser Code versteht. */
  version: number;
  /** Prüft den Payload und gibt ihn typisiert zurück, sonst `null`. */
  parse(payload: unknown, version: number): T | null;
}

export type DecodedEvent<T> =
  | { kind: "known"; event: StoredEvent; payload: T }
  | { kind: "unknown"; event: StoredEvent; reason: "type" | "version" | "payload" };

export class EventRegistry {
  private readonly types = new Map<string, EventType<unknown>>();

  register<T>(eventType: EventType<T>): EventType<T> {
    if (this.types.has(eventType.type)) {
      throw new Error(`Ereignistyp ${eventType.type} ist doppelt registriert`);
    }
    this.types.set(eventType.type, eventType);
    return eventType;
  }

  decode(event: StoredEvent): DecodedEvent<unknown> {
    const eventType = this.types.get(event.type);
    if (eventType === undefined) {
      return { kind: "unknown", event, reason: "type" };
    }
    if (event.version > eventType.version) {
      return { kind: "unknown", event, reason: "version" };
    }
    const payload = eventType.parse(event.payload, event.version);
    if (payload === null) {
      return { kind: "unknown", event, reason: "payload" };
    }
    return { kind: "known", event, payload };
  }

  /** Typisierter Zugriff, wenn der Typ bekannt ist. */
  decodeAs<T>(eventType: EventType<T>, event: StoredEvent): T | null {
    if (event.type !== eventType.type || event.version > eventType.version) {
      return null;
    }
    return eventType.parse(event.payload, event.version);
  }
}
