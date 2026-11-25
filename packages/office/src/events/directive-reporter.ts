import type { Office } from "../domain/office.ts";
import type { IpcParams, IpcResult } from "../ipc/protocol.ts";

/**
 * Meldet Weisungen des CEO an den Supervisor (`directive.report`, plan.md E38, E68). Der CEO gibt
 * sie im Webinterface; das Office speichert sie als Ereignis und wendet sie an. Maßgeblicher
 * Nachweis ist nach E38 aber das Audit-Log des Supervisors. Deshalb geht jede Weisung und jede
 * Rücknahme dorthin, in der Reihenfolge des Protokolls.
 *
 * Der Fortschritt liegt nur im Speicher. Nach einem Neustart meldet das Office alles noch einmal;
 * der Supervisor schreibt eine schon bekannte Meldung nicht doppelt (`recorded: false`). Scheitert
 * ein Aufruf, hört der Durchlauf auf, damit eine Rücknahme nie vor ihrer Weisung ankommt.
 */

/** Zugriff auf den Supervisor, im Betrieb über `SupervisorClient.call` (P02). */
export interface DirectiveAccess {
  reportDirective(params: IpcParams<"directive.report">): Promise<IpcResult<"directive.report">>;
}

export interface DirectiveReport {
  /** In diesem Durchlauf gemeldet. */
  sent: number;
  /** Davon neu im Audit-Log. */
  recorded: number;
  /** Noch nicht gemeldet. */
  pending: number;
  error: string | null;
}

export class DirectiveReporter {
  private readonly office: Office;
  private readonly access: DirectiveAccess;
  /** Schlüssel `<action>:<directiveId>` der schon gemeldeten. */
  private readonly reported = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { office: Office; access: DirectiveAccess }) {
    this.office = options.office;
    this.access = options.access;
  }

  /** Meldet alles Offene. Nie zwei Durchläufe gleichzeitig. */
  report(): Promise<DirectiveReport> {
    const next = this.queue.then(() => this.run());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run(): Promise<DirectiveReport> {
    this.office.sync();
    const open = this.open();
    const report: DirectiveReport = { sent: 0, recorded: 0, pending: open.length, error: null };
    for (const item of open) {
      try {
        const answer = await this.access.reportDirective(item.params);
        this.reported.add(item.key);
        report.sent += 1;
        report.pending -= 1;
        if (answer.recorded) {
          report.recorded += 1;
        }
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    return report;
  }

  /** Noch nicht gemeldete Weisungen und Rücknahmen, nach ihrer Nummer im Protokoll. */
  private open(): { key: string; seq: number; params: IpcParams<"directive.report"> }[] {
    const items: { key: string; seq: number; params: IpcParams<"directive.report"> }[] = [];
    for (const d of this.office.state.directives()) {
      items.push({
        key: `issued:${d.id}`,
        seq: d.seq,
        params: {
          action: "issued",
          directiveId: d.id,
          text: d.text,
          agentIds: d.agentIds === null ? null : [...d.agentIds],
          officeSeq: d.seq,
        },
      });
      if (d.revokedSeq !== null) {
        items.push({
          key: `revoked:${d.id}`,
          seq: d.revokedSeq,
          params: { action: "revoked", directiveId: d.id, officeSeq: d.revokedSeq },
        });
      }
    }
    return items.filter((item) => !this.reported.has(item.key)).sort((a, b) => a.seq - b.seq);
  }
}
