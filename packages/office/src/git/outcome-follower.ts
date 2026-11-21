import type { Office } from "../domain/office.ts";
import type { GitOutcome } from "../domain/events.ts";
import type { GitOutcomeRecord } from "../domain/office-state.ts";
import type { IpcResult } from "../ipc/protocol.ts";

/**
 * Holt für beendete Werkbank-Läufe den Stand der Übergabe beim Git-Gate ab (Office-Seite von
 * S08, plan.md Kap. 5.9) und hält den endgültigen Stand als `git.outcome` fest. Der nächste Lauf
 * zur selben Aufgabe sieht ihn im Kontext (`buildContext`): PR-Nummer oder Grund der Ablehnung.
 *
 * - Gefragt wird nur nach Läufen mit `run.finished`: Das Gate beginnt erst, wenn der Container
 *   beendet ist, und der Supervisor legt den Auftrag vor `ende.json` an. Danach heißt „kein
 *   Auftrag“ verlässlich `none`.
 * - `pending` und `pushed` sind Zwischenstände. Sie bleiben ungeschrieben, der nächste Durchlauf
 *   fragt wieder.
 * - Ohne Git-Gate antwortet der Supervisor mit `not_available`. Dann bricht der Durchlauf ab und
 *   meldet das, statt für jeden Lauf denselben Fehler zu sammeln.
 *
 * Der Zustand liegt nur im Ereignisprotokoll: Nach einem Neustart fragt der Durchlauf alle
 * Werkbank-Läufe ohne `git.outcome` erneut, das Schreiben ist idempotent.
 */

/** Zugriff auf das Git-Gate, im Betrieb `supervisorGitAccess` (P02). */
export interface GitAccess {
  status(runId: string): Promise<IpcResult<"git.status">>;
}

export interface GitOutcomeResult {
  recorded: GitOutcomeRecord[];
  /** Noch nicht endgültig: `pending` oder `pushed`. */
  pending: { runId: string; state: "pending" | "pushed" }[];
  failed: { runId: string; error: string }[];
  /** Der Supervisor hat kein Git-Gate (`not_available`); der Durchlauf hat abgebrochen. */
  unavailable: boolean;
}

export class GitOutcomeFollower {
  private readonly office: Office;
  private readonly access: GitAccess;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { office: Office; access: GitAccess }) {
    this.office = options.office;
    this.access = options.access;
  }

  /** Ein Durchlauf über alle beendeten Werkbank-Läufe ohne endgültigen Stand. Nie gleichzeitig. */
  poll(): Promise<GitOutcomeResult> {
    const next = this.queue.then(() => this.run());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run(): Promise<GitOutcomeResult> {
    const result: GitOutcomeResult = { recorded: [], pending: [], failed: [], unavailable: false };
    this.office.sync();
    const state = this.office.state;
    const open = state
      .runs()
      .filter((r) => r.runType === "werkbank" && state.gitOutcome(r.runId) === undefined);
    for (const run of open) {
      let answer: IpcResult<"git.status">;
      try {
        answer = await this.access.status(run.runId);
      } catch (error) {
        if (isNotAvailable(error)) {
          result.unavailable = true;
          return result;
        }
        result.failed.push({ runId: run.runId, error: message(error) });
        continue;
      }
      const outcome = finalOutcome(answer);
      if (outcome === null) {
        result.pending.push({ runId: run.runId, state: answer.state as "pending" | "pushed" });
        continue;
      }
      try {
        result.recorded.push(this.office.recordGitOutcome(run.runId, outcome));
      } catch (error) {
        result.failed.push({ runId: run.runId, error: message(error) });
      }
    }
    return result;
  }
}

/** Endgültiger Stand aus der Antwort, `null` bei einem Zwischenstand. */
export function finalOutcome(answer: IpcResult<"git.status">): GitOutcome | null {
  const empty = { branch: null, head: null, pr: null, url: null, reason: null };
  switch (answer.state) {
    case "pending":
    case "pushed":
      return null;
    case "none":
    case "unknown":
      return { state: answer.state, ...empty };
    case "rejected":
    case "failed":
      return { state: answer.state, ...empty, reason: answer.reason };
    case "pr_opened":
      return {
        state: "pr_opened",
        branch: answer.branch,
        head: answer.head,
        pr: answer.pr,
        url: answer.url,
        reason: null,
      };
  }
}

function isNotAvailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "not_available"
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
