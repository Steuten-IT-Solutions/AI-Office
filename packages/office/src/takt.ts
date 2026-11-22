import type { RunTokens } from "./api/run-tokens.ts";
import type { HeadReporter } from "./events/head-reporter.ts";
import type { FingerprintReporter } from "./git/fingerprints.ts";
import type { MergeStatusFollower } from "./git/merge-follower.ts";
import type { GitOutcomeFollower } from "./git/outcome-follower.ts";
import { errorText, type Logger } from "./log.ts";
import type { Planner } from "./planner/planner.ts";
import type { RunFollower } from "./runs/run-follower.ts";

/**
 * Takt des Office: ruft Planer, Begleiter und Melder regelmäßig auf (Office-Seite von S05, S08,
 * S09 und E38). Jeder Teil hat seine eigene Schleife mit eigenem Abstand. Ein Teil läuft nie
 * zweimal gleichzeitig; der nächste Durchlauf beginnt erst, wenn der letzte fertig ist, plus den
 * Abstand. Ein Fehler in einem Teil hält die anderen nicht auf.
 *
 * | Teil | Aufgabe | Abstand |
 * |---|---|---|
 * | `planner` | Weckregeln anwenden, Läufe beantragen (P06) | 10 s |
 * | `runs` | Token abholen, Ausgabe lesen, Läufe abschließen (S05) | 2 s |
 * | `gitOutcomes` | Stand der Übergabe beim Git-Gate (S08) | 15 s |
 * | `merges` | Stand des Merge-Antrags beim Merge-Gate (S09) | 60 s |
 * | `fingerprints` | Fingerabdrücke für den Ausgangsfilter (S08) | 30 s |
 * | `head` | Kopf der Hash-Kette an den Supervisor (E38) | 60 s |
 *
 * Alle Abstände sind [Annahme], gewählt nach diesen Grenzen:
 * - `runs`: Der Supervisor beendet einen Lauf ungestartet, wenn das Office das Token nicht
 *   innerhalb von `tokenWaitSeconds` abholt (S05, Standard 60 s). Gedankenblasen sollen während
 *   des Laufs erscheinen, nicht erst am Ende.
 * - `planner`: Die Bündelung rechnet in Minuten (Standard 15). Eine Nachricht des CEO stößt den
 *   Planer sofort an, Nachrichten der Agenten warten höchstens einen Abstand.
 * - `merges`: Der Supervisor fragt GitHub selbst nur alle 60 s ab (E51). Öfter zu fragen, brächte
 *   keinen neueren Stand.
 *
 * Teile stoßen einander an, statt auf ihren Abstand zu warten:
 * - Hat der Planer einen Lauf zugelassen, folgt sofort `runs`, damit das Token rechtzeitig
 *   abgeholt wird.
 * - Ist ein Lauf beendet, folgen `planner` (der Agent ist frei, seine Nachrichten wecken andere),
 *   `gitOutcomes` und `fingerprints`.
 * - Ist eine Übergabe endgültig, folgen `fingerprints` (zurückgestellte Texte des Laufs) und
 *   `merges`.
 *
 * Probleme gehen einmal ins Protokoll und noch einmal, wenn sie sich ändern oder vorbei sind.
 * Sonst stünde z. B. bei einem gestoppten Supervisor alle 2 s derselbe Fehler im Journal.
 */

export const TAKT_JOBS = [
  "planner",
  "runs",
  "gitOutcomes",
  "merges",
  "fingerprints",
  "head",
] as const;
export type TaktJob = (typeof TAKT_JOBS)[number];

export type TaktIntervals = Record<TaktJob, number>;

export const DEFAULT_TAKT_INTERVALS: Readonly<TaktIntervals> = Object.freeze({
  planner: 10_000,
  runs: 2_000,
  gitOutcomes: 15_000,
  merges: 60_000,
  fingerprints: 30_000,
  head: 60_000,
});

/** Die Teile, die der Takt aufruft. Im Betrieb die Klassen aus P06, S05, S08, S09 und E38. */
export interface TaktParts {
  planner: Pick<Planner, "tick">;
  runs: Pick<RunFollower, "poll">;
  gitOutcomes: Pick<GitOutcomeFollower, "poll">;
  merges: Pick<MergeStatusFollower, "poll">;
  fingerprints: Pick<FingerprintReporter, "report">;
  head: Pick<HeadReporter, "report">;
  /** Abgelaufene Office-Tokens entfernt der Takt bei jedem Durchlauf von `runs`. */
  tokens: Pick<RunTokens, "prune">;
}

export interface TaktOptions {
  parts: TaktParts;
  log: Logger;
  intervals?: Partial<TaktIntervals>;
  /** Uhr für das Entfernen abgelaufener Tokens. Standard: Systemzeit. */
  now?: () => Date;
}

interface Slot {
  timer: NodeJS.Timeout | undefined;
  running: Promise<void> | undefined;
  /** Während des Durchlaufs angestoßen: gleich danach noch einmal. */
  again: boolean;
  /** Zuletzt gemeldetes Problem, `null`, wenn der letzte Durchlauf ohne Problem war. */
  problem: string | null;
}

/** Sammelt Probleme eines Durchlaufs. */
type Problems = string[];

export class OfficeTakt {
  private readonly parts: TaktParts;
  private readonly log: Logger;
  private readonly intervals: TaktIntervals;
  private readonly now: () => Date;
  private readonly slots: Record<TaktJob, Slot>;
  private started = false;
  private stopped = false;

  constructor(options: TaktOptions) {
    const intervals = { ...DEFAULT_TAKT_INTERVALS, ...options.intervals };
    for (const job of TAKT_JOBS) {
      const ms = intervals[job];
      if (!Number.isInteger(ms) || ms < 1) {
        throw new Error(`Abstand für ${job} muss eine ganze Zahl ab 1 ms sein`);
      }
    }
    this.parts = options.parts;
    this.log = options.log;
    this.intervals = intervals;
    this.now = options.now ?? (() => new Date());
    const slot = (): Slot => ({
      timer: undefined,
      running: undefined,
      again: false,
      problem: null,
    });
    this.slots = {
      planner: slot(),
      runs: slot(),
      gitOutcomes: slot(),
      merges: slot(),
      fingerprints: slot(),
      head: slot(),
    };
  }

  /** Startet alle Teile sofort. Mehrfacher Aufruf ist unschädlich. */
  start(): void {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    for (const job of TAKT_JOBS) {
      this.fire(job);
    }
  }

  /** Lässt einen Teil so bald wie möglich laufen, z. B. nach einer Nachricht des CEO. */
  kick(job: TaktJob): void {
    if (!this.started || this.stopped) {
      return;
    }
    this.fire(job);
  }

  /** Hält alle Teile an und wartet, bis laufende Durchläufe fertig sind. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const slot of Object.values(this.slots)) {
      clearTimeout(slot.timer);
      slot.timer = undefined;
    }
    await this.settled();
  }

  /** Ob ein Teil gerade läuft. */
  isRunning(job: TaktJob): boolean {
    return this.slots[job].running !== undefined;
  }

  /** Wartet, bis gerade laufende Durchläufe fertig sind (für Tests). */
  async idle(): Promise<void> {
    while (Object.values(this.slots).some((slot) => slot.running !== undefined)) {
      await this.settled();
    }
  }

  private async settled(): Promise<void> {
    const running = Object.values(this.slots)
      .map((slot) => slot.running)
      .filter((p): p is Promise<void> => p !== undefined);
    await Promise.all(running);
  }

  private fire(job: TaktJob): void {
    const slot = this.slots[job];
    if (this.stopped) {
      return;
    }
    if (slot.running !== undefined) {
      slot.again = true;
      return;
    }
    clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.running = this.execute(job).finally(() => {
      slot.running = undefined;
      const delay = slot.again ? 0 : this.intervals[job];
      slot.again = false;
      if (!this.stopped) {
        slot.timer = setTimeout(() => {
          slot.timer = undefined;
          this.fire(job);
        }, delay);
      }
    });
  }

  private async execute(job: TaktJob): Promise<void> {
    const problems: Problems = [];
    try {
      await this.step(job, problems);
    } catch (error) {
      problems.push(errorText(error));
    }
    const slot = this.slots[job];
    const text = problems.length === 0 ? null : problems.join("; ");
    if (text === slot.problem) {
      return;
    }
    if (text === null) {
      this.log.info("Takt: wieder ohne Problem", { job });
    } else {
      this.log.warn("Takt: Problem", { job, problem: text });
    }
    slot.problem = text;
  }

  private async step(job: TaktJob, problems: Problems): Promise<void> {
    switch (job) {
      case "planner":
        return this.planner(problems);
      case "runs":
        return this.runs(problems);
      case "gitOutcomes":
        return this.gitOutcomes(problems);
      case "merges":
        return this.merges(problems);
      case "fingerprints":
        return this.fingerprints(problems);
      case "head":
        return this.head();
    }
  }

  private async planner(problems: Problems): Promise<void> {
    const result = await this.parts.planner.tick();
    for (const run of result.started) {
      this.log.info("Lauf zugelassen", {
        runId: run.runId,
        agentId: run.agentId,
        taskId: run.taskId,
        runType: run.runType,
      });
    }
    for (const rejected of result.rejected) {
      this.log.info("Lauf abgelehnt", { agentId: rejected.agentId, reason: rejected.reason });
    }
    for (const failed of result.failed) {
      problems.push(`${failed.agentId}: ${failed.error}`);
    }
    problems.push(...result.errors);
    if (result.notices > 0 || result.forwards > 0) {
      this.log.info("Planer: Hinweise und Weitergaben", {
        notices: result.notices,
        forwards: result.forwards,
      });
    }
    if (result.started.length > 0) {
      this.kick("runs");
    }
  }

  private async runs(problems: Problems): Promise<void> {
    this.parts.tokens.prune(this.now());
    const result = await this.parts.runs.poll();
    for (const runId of result.registered) {
      this.log.info("Office-Token angemeldet", { runId });
    }
    for (const { run, end } of result.finished) {
      this.log.info("Lauf abgeschlossen", {
        runId: run.runId,
        agentId: run.agentId,
        exit: run.exit,
        reason: end?.reason ?? "dem Supervisor unbekannt",
        truncated: end?.truncated ?? false,
      });
    }
    for (const failed of result.failed) {
      problems.push(`${failed.runId}: ${failed.error}`);
    }
    if (result.finished.length > 0) {
      this.kick("planner");
      this.kick("gitOutcomes");
      this.kick("fingerprints");
    }
  }

  private async gitOutcomes(problems: Problems): Promise<void> {
    const result = await this.parts.gitOutcomes.poll();
    for (const outcome of result.recorded) {
      this.log.info("Übergabe ins Repo festgehalten", {
        runId: outcome.runId,
        state: outcome.state,
        pr: outcome.pr,
      });
    }
    for (const failed of result.failed) {
      problems.push(`${failed.runId}: ${failed.error}`);
    }
    if (result.unavailable) {
      problems.push("Der Supervisor hat kein Git-Gate (not_available)");
    }
    if (result.recorded.length > 0) {
      this.kick("fingerprints");
      if (result.recorded.some((outcome) => outcome.state === "pr_opened")) {
        this.kick("merges");
      }
    }
  }

  private async merges(problems: Problems): Promise<void> {
    const result = await this.parts.merges.poll();
    for (const merge of result.recorded) {
      this.log.info("Merge-Stand festgehalten", {
        runId: merge.runId,
        state: merge.state,
        pr: merge.pr,
      });
    }
    for (const failed of result.failed) {
      problems.push(`${failed.runId}: ${failed.error}`);
    }
    if (result.unavailable) {
      problems.push("Der Supervisor hat kein Merge-Gate (not_available)");
    }
  }

  private async fingerprints(problems: Problems): Promise<void> {
    const report = await this.parts.fingerprints.report();
    if (report.sent > 0) {
      this.log.debug("Fingerabdrücke gemeldet", { sent: report.sent, added: report.added });
    }
    if (report.error !== null) {
      problems.push(`${String(report.unsent)} Fingerabdrücke offen: ${report.error}`);
    }
  }

  private async head(): Promise<void> {
    const report = await this.parts.head.report();
    if (report.reported !== null) {
      this.log.debug("Kopf der Hash-Kette gemeldet", {
        seq: report.reported.seq,
        auditSeq: report.auditSeq,
      });
    }
  }
}
