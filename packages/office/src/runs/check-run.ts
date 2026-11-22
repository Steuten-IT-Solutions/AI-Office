import type { RunTokens } from "../api/run-tokens.ts";
import type { EventStore } from "../events/event-store.ts";
import type { HeadReporter } from "../events/head-reporter.ts";
import type { IpcParams, IpcResult } from "../ipc/protocol.ts";
import { OutcomeCollector, type RunExit } from "../llm/runner.ts";
import { LineSplitter, parseLine } from "../llm/stream-json.ts";
import type { RunAccess } from "./run-follower.ts";

/**
 * Prüflauf über die echte Kette, Office-Seite (S11b, plan.md Kap. 4.5 Nr. 8, CEO-Entscheidung vom
 * 22.11.2026).
 *
 * Der Health-Check des Supervisors bestellt einen Lauf, um den Ende-zu-Ende-Lauf mit dem
 * Fake-Runner, den Migrationsstand und „Ereignisprotokoll schreibbar“ zu prüfen; die Datenbank
 * des Office darf er nicht lesen. Das Office wickelt den Prüflauf über dieselben Wege ab wie jeden
 * Lauf:
 *
 * 1. `fetch` (Takt `checkRuns`): `checkRun.next` fragt nach einem Auftrag, `checkRun.request`
 *    fordert ihn an. Das Office hält den Beginn als `check_run.started` fest.
 * 2. `poll` (Takt `runs`, wie der `RunFollower`): `run.token` holt das Office-Token (erst dann
 *    startet der Container) und meldet es in `RunTokens` an, damit die Office-API den Lauf
 *    annimmt. `run.output` liefert das Rohprotokoll; jede Zeile geht durch den Parser aus P04.
 * 3. Am Ende: `check_run.finished` mit dem Ausgang der Auswertung, Token zurückziehen, Kopf der
 *    Kette melden (`office.reportHead`), dann `checkRun.report` mit Auswertung, Migrationsstand
 *    und der Nummer von `check_run.finished`.
 *
 * Der Prüflauf gehört keinem Agenten und keiner Aufgabe. Er geht deshalb nicht durch Planer und
 * `RunEvaluation`: Seine Ereignisse sind keine Domänenereignisse, ältere Releases und das
 * Webinterface übergehen sie (E24). Das Token gilt für den Agenten `pruefung` als Büro-Lauf.
 *
 * Fehler: Scheitert ein Aufruf beim Supervisor, bleibt der Stand, und der nächste Durchlauf
 * versucht es noch einmal. Ein Neustart des Office verliert einen laufenden Prüflauf; der
 * Health-Check meldet ihn dann als nicht ausgewertet.
 */

export const CHECK_RUN_STARTED = "check_run.started";
export const CHECK_RUN_FINISHED = "check_run.finished";
/** Agent, für den das Office-Token des Prüflaufs gilt. Kein Agent des Büros. */
export const CHECK_AGENT = "pruefung";

/** Zugriff auf die Prüfläufe, im Betrieb `supervisorCheckRunAccess` (P02). */
export interface CheckRunAccess {
  next(): Promise<IpcResult<"checkRun.next">>;
  request(runId: string): Promise<IpcResult<"checkRun.request">>;
  report(params: IpcParams<"checkRun.report">): Promise<IpcResult<"checkRun.report">>;
}

export interface CheckRunFollowerOptions {
  store: Pick<EventStore, "append" | "migration">;
  access: CheckRunAccess;
  runs: RunAccess;
  tokens: RunTokens;
  head: Pick<HeadReporter, "report">;
  /** Höchstzahl Ausschnitte je Durchlauf. Ein Fake-CLI schreibt wenige Zeilen. */
  maxSlicesPerPoll?: number;
}

/** Was ein Durchlauf von `fetch` oder `poll` getan hat. */
export interface CheckRunStep {
  /** Angefordert in diesem Durchlauf. */
  started: string | null;
  /** Abgeschlossen und gemeldet in diesem Durchlauf. */
  reported: { runId: string; exit: RunExit; recorded: boolean } | null;
  /** Abgelehnt vom Supervisor, mit Grund. */
  rejected: string | null;
  /** Der Supervisor kennt keine Prüfläufe (älteres Release). */
  unavailable: boolean;
}

interface Current {
  runId: string;
  tokenDone: boolean;
  offset: number;
  splitter: LineSplitter;
  collector: OutcomeCollector;
  /** Nach dem Ende gesetzt; bis die Meldung durch ist, bleibt der Prüflauf offen. */
  finished: { exit: RunExit; invalidLines: number; seq: number } | null;
}

const empty = (): CheckRunStep => ({
  started: null,
  reported: null,
  rejected: null,
  unavailable: false,
});

export class CheckRunFollower {
  private readonly options: CheckRunFollowerOptions;
  private current: Current | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: CheckRunFollowerOptions) {
    this.options = options;
  }

  /** Lauf-ID des offenen Prüflaufs, `null` ohne einen. */
  get following(): string | null {
    return this.current?.runId ?? null;
  }

  /** Fragt nach einem Auftrag und fordert ihn an. Nie gleichzeitig mit `poll`. */
  fetch(): Promise<CheckRunStep> {
    return this.serial(() => this.fetchNow());
  }

  /** Bringt den offenen Prüflauf weiter. Nie gleichzeitig mit `fetch`. */
  poll(): Promise<CheckRunStep> {
    return this.serial(() => this.pollNow());
  }

  private serial(fn: () => Promise<CheckRunStep>): Promise<CheckRunStep> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async fetchNow(): Promise<CheckRunStep> {
    const step = empty();
    if (this.current !== null) {
      return step;
    }
    let next: IpcResult<"checkRun.next">;
    try {
      next = await this.options.access.next();
    } catch (error) {
      if (isUnavailable(error)) {
        step.unavailable = true;
        return step;
      }
      throw error;
    }
    if (next.state === "none") {
      return step;
    }
    const answer = await this.options.access.request(next.runId);
    if (answer.decision === "rejected") {
      step.rejected = answer.reason;
      return step;
    }
    this.options.store.append({
      type: CHECK_RUN_STARTED,
      actor: "system",
      runId: answer.runId,
      payload: { runId: answer.runId },
      idempotencyKey: `${answer.runId}:${CHECK_RUN_STARTED}`,
    });
    this.current = {
      runId: answer.runId,
      tokenDone: false,
      offset: 0,
      splitter: new LineSplitter(),
      collector: new OutcomeCollector(answer.runId),
      finished: null,
    };
    step.started = answer.runId;
    return step;
  }

  private async pollNow(): Promise<CheckRunStep> {
    const step = empty();
    const current = this.current;
    if (current === null) {
      return step;
    }
    if (current.finished === null && !(await this.follow(current))) {
      return step;
    }
    const finished = current.finished;
    if (finished === null) {
      return step;
    }
    // Erst den Kopf, dann die Meldung: Der Health-Check prüft, dass ein gemeldeter Kopf bis zu
    // `check_run.finished` reicht.
    await this.options.head.report();
    const migration = this.options.store.migration;
    const answer = await this.options.access.report({
      runId: current.runId,
      exit: finished.exit,
      invalidLines: finished.invalidLines,
      migration: {
        databaseVersion: migration.databaseVersion,
        codeVersion: migration.codeVersion,
        unknownExpand: [...migration.unknownExpand],
      },
      finishedSeq: finished.seq,
    });
    this.current = null;
    step.reported = { runId: current.runId, exit: finished.exit, recorded: answer.recorded };
    return step;
  }

  /** Token und Ausgabe; `true`, sobald der Lauf beendet und festgehalten ist. */
  private async follow(current: Current): Promise<boolean> {
    const { runId } = current;
    if (!current.tokenDone) {
      const answer = await this.options.runs.token(runId);
      if (answer.state === "started" && !this.options.tokens.hasRun(runId)) {
        this.options.tokens.register(answer.officeToken, {
          runId,
          agentId: CHECK_AGENT,
          taskId: null,
          runType: "buero",
          expiresAt: new Date(answer.expiresAt),
        });
      }
      current.tokenDone = true;
    }
    const maxSlices = this.options.maxSlicesPerPoll ?? 16;
    for (let slice = 0; slice < maxSlices; slice += 1) {
      const answer = await this.options.runs.output(runId, current.offset);
      if (answer.state === "unknown") {
        this.finish(current, false);
        return true;
      }
      if (answer.data !== "") {
        if (answer.nextOffset <= current.offset) {
          throw new Error(
            `run.output: Offset rückt nicht vor (${String(current.offset)} → ${String(answer.nextOffset)})`,
          );
        }
        current.offset = answer.nextOffset;
        for (const line of current.splitter.push(answer.data)) {
          this.add(current, line);
        }
        continue;
      }
      if (answer.state === "ended") {
        const aborted = answer.end.finishedBy === "lease" || answer.end.finishedBy === "stopp";
        this.finish(current, aborted);
        return true;
      }
      return false;
    }
    return false;
  }

  private add(current: Current, line: string): void {
    for (const event of parseLine(line)) {
      current.collector.add(event);
    }
  }

  private finish(current: Current, aborted: boolean): void {
    for (const line of current.splitter.end()) {
      this.add(current, line);
    }
    const outcome = current.collector.finish(aborted);
    this.options.tokens.revoke(current.runId);
    const event = this.options.store.append({
      type: CHECK_RUN_FINISHED,
      actor: "system",
      runId: current.runId,
      payload: {
        runId: current.runId,
        exit: outcome.exit,
        invalidLines: outcome.invalidLines,
        resultSubtype: outcome.resultSubtype,
      },
      idempotencyKey: `${current.runId}:${CHECK_RUN_FINISHED}`,
    });
    current.finished = { exit: outcome.exit, invalidLines: outcome.invalidLines, seq: event.seq };
  }
}

/** Ein Supervisor vor S11b kennt die Methoden nicht oder bietet sie nicht an. */
function isUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "not_available" || code === "unknown_method";
}
