import type { IpcParams, IpcResult } from "../ipc/protocol.ts";
import type { ChainHead, EventStore } from "./event-store.ts";

/**
 * Meldet den Kopf der Hash-Kette an den Supervisor (`office.reportHead`, plan.md E38, Verfassung
 * Nr. 6). Der Supervisor hält jede Meldung im Audit-Log fest. Ändert das Office später ein
 * Ereignis vor diesem Stand, passt die Kette nicht mehr zum gemeldeten Kopf, und ein Vergleich
 * (Health-Check, Sicherung) zeigt das.
 *
 * Gemeldet wird nur ein neuer Stand. Der Fortschritt liegt nur im Speicher: Nach einem Neustart
 * meldet das Office den aktuellen Kopf einmal neu, auch wenn er schon gemeldet war. Das schadet
 * nicht, das Audit-Log hat dann zwei gleiche Einträge.
 */

/** Zugriff auf den Supervisor, im Betrieb über `SupervisorClient.call` (P02). */
export interface HeadAccess {
  reportHead(params: IpcParams<"office.reportHead">): Promise<IpcResult<"office.reportHead">>;
}

export interface HeadReport {
  /** Gemeldeter Kopf, `null`, wenn er sich seit der letzten Meldung nicht geändert hat. */
  reported: ChainHead | null;
  /** Laufende Nummer im Audit-Log des Supervisors. */
  auditSeq: number | null;
}

export class HeadReporter {
  private readonly store: EventStore;
  private readonly access: HeadAccess;
  private last: ChainHead | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { store: EventStore; access: HeadAccess }) {
    this.store = options.store;
    this.access = options.access;
  }

  /** Meldet den Kopf, wenn er neu ist. Nie zwei Meldungen gleichzeitig. Wirft bei Fehlern. */
  report(): Promise<HeadReport> {
    const next = this.queue.then(() => this.run());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run(): Promise<HeadReport> {
    const head = this.store.head();
    if (this.last !== null && this.last.seq === head.seq && this.last.hash === head.hash) {
      return { reported: null, auditSeq: null };
    }
    const answer = await this.access.reportHead({ seq: head.seq, hash: head.hash });
    this.last = head;
    return { reported: head, auditSeq: answer.auditSeq };
  }
}
