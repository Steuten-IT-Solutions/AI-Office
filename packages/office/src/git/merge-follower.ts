import type { Office } from "../domain/office.ts";
import { GIT_MERGE_FINAL_STATES, type GitMerge } from "../domain/events.ts";
import {
  MAX_GIT_MERGE_EVENTS_PER_RUN,
  sameGitMerge,
  type GitMergeRecord,
} from "../domain/office-state.ts";
import type { IpcResult } from "../ipc/protocol.ts";

/**
 * Holt für PRs aus Werkbank-Läufen den Stand des Merge-Antrags beim Merge-Gate ab (Office-Seite
 * von S09) und hält jeden neuen Stand als `git.merge` fest. Der nächste Lauf zur selben Aufgabe
 * sieht ihn im Kontext (`buildContext`, Abschnitt „Merge-Stand“): gemergt, gesperrt oder worauf
 * das Gate noch wartet.
 *
 * - Gefragt wird mit der Lauf-ID, deren `git.outcome` `pr_opened` ist. So findet der Supervisor
 *   den Antrag (`sourceRunId`), auch wenn ein späterer Lauf den Merge beantragt hat.
 * - `none` (noch kein Antrag) schreibt das Office nicht. Ein Agent kann den Merge jederzeit
 *   später beantragen; der Durchlauf fragt deshalb weiter.
 * - Nach `merged`, `closed` oder `blocked` fragt er nicht mehr. PRs, deren Übergabe älter als
 *   `followDays` ist, fragt er ebenfalls nicht mehr, sonst wüchse jeder Durchlauf mit jedem
 *   liegen gebliebenen PR.
 * - Ohne Merge-Gate antwortet der Supervisor mit `not_available`. Dann bricht der Durchlauf ab
 *   und meldet das.
 *
 * Der Zustand liegt nur im Ereignisprotokoll: Nach einem Neustart fragt der Durchlauf alle PRs
 * ohne endgültigen Stand erneut; ein unveränderter Stand wird nicht noch einmal geschrieben.
 */

/** Zugriff auf das Merge-Gate, im Betrieb `supervisorGitAccess` (P02). */
export interface MergeAccess {
  mergeStatus(runId: string): Promise<IpcResult<"git.merge_status">>;
}

/** Wie lange nach der Übergabe ein PR verfolgt wird, wenn kein endgültiger Stand kommt. */
export const MERGE_FOLLOW_DAYS = 30;

export interface MergeFollowResult {
  recorded: GitMergeRecord[];
  /** Noch nicht endgültig: kein Antrag oder wartend, ohne neuen Stand. */
  open: { runId: string; state: "none" | "waiting" }[];
  failed: { runId: string; error: string }[];
  /** Der Supervisor hat kein Merge-Gate (`not_available`); der Durchlauf hat abgebrochen. */
  unavailable: boolean;
}

export class MergeStatusFollower {
  private readonly office: Office;
  private readonly access: MergeAccess;
  private readonly followMs: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { office: Office; access: MergeAccess; followDays?: number }) {
    this.office = options.office;
    this.access = options.access;
    this.followMs = (options.followDays ?? MERGE_FOLLOW_DAYS) * 24 * 60 * 60 * 1000;
  }

  /** Ein Durchlauf über alle verfolgten PRs ohne endgültigen Stand. Nie gleichzeitig. */
  poll(): Promise<MergeFollowResult> {
    const next = this.queue.then(() => this.run());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run(): Promise<MergeFollowResult> {
    const result: MergeFollowResult = { recorded: [], open: [], failed: [], unavailable: false };
    this.office.sync();
    const state = this.office.state;
    const since = this.office.now().getTime() - this.followMs;
    const followed = state.runs().filter((r) => {
      const outcome = state.gitOutcome(r.runId);
      if (outcome?.state !== "pr_opened" || Date.parse(outcome.occurredAt) < since) {
        return false;
      }
      const last = state.gitMerge(r.runId);
      return last === undefined || !GIT_MERGE_FINAL_STATES.includes(last.state);
    });
    for (const run of followed) {
      let answer: IpcResult<"git.merge_status">;
      try {
        answer = await this.access.mergeStatus(run.runId);
      } catch (error) {
        if (isNotAvailable(error)) {
          result.unavailable = true;
          return result;
        }
        result.failed.push({ runId: run.runId, error: message(error) });
        continue;
      }
      const merge = mergeFromStatus(answer);
      if (merge === null) {
        result.open.push({ runId: run.runId, state: "none" });
        continue;
      }
      const last = state.gitMerge(run.runId);
      const full = state.gitMerges(run.runId).length >= MAX_GIT_MERGE_EVENTS_PER_RUN - 1;
      const final = GIT_MERGE_FINAL_STATES.includes(merge.state);
      if ((last !== undefined && sameGitMerge(last, merge)) || (full && !final)) {
        result.open.push({ runId: run.runId, state: "waiting" });
        continue;
      }
      try {
        result.recorded.push(this.office.recordGitMerge(run.runId, merge));
      } catch (error) {
        result.failed.push({ runId: run.runId, error: message(error) });
      }
    }
    return result;
  }
}

/** Stand aus der Antwort des Supervisors, `null` ohne Merge-Antrag. */
export function mergeFromStatus(answer: IpcResult<"git.merge_status">): GitMerge | null {
  const empty = { waitingFor: null, reason: null, mergeSha: null, tag: null };
  switch (answer.state) {
    case "none":
      return null;
    case "waiting":
      return {
        ...empty,
        state: "waiting",
        pr: answer.pr,
        waitingFor: answer.waitingFor,
        reason: answer.reason,
      };
    case "merged":
      return {
        ...empty,
        state: "merged",
        pr: answer.pr,
        mergeSha: answer.mergeSha,
        tag: answer.tag,
      };
    case "closed":
      return {
        ...empty,
        state: "closed",
        pr: answer.pr,
        reason: answer.reason,
        mergeSha: answer.mergeSha,
      };
    case "blocked":
      return { ...empty, state: "blocked", pr: answer.pr, reason: answer.reason };
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
