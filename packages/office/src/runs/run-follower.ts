import type { RunTokens } from "../api/run-tokens.ts";
import type { Office } from "../domain/office.ts";
import type { RunRecord, RunStart } from "../domain/office-state.ts";
import { RunEvaluation, type RunInfo } from "../domain/run-evaluation.ts";
import type { IpcResult } from "../ipc/protocol.ts";
import { OutcomeCollector } from "../llm/runner.ts";
import { LineSplitter, parseLine, type RunEvent } from "../llm/stream-json.ts";
import { runInfo } from "../planner/planner.ts";

/**
 * Begleitet die zugelassenen Läufe vom Start bis zum Abschluss (Office-Seite von S05, plan.md
 * Kap. 3.3 Schritt 4 bis 6, Kap. 4.6 „Identität eines Laufs“, E40).
 *
 * Je Lauf, den das Office mit `run.started` festgehalten und noch nicht mit `run.finished`
 * abgeschlossen hat:
 * 1. **Token:** `run.token` holt das Office-Token. Erst damit startet der Supervisor den Container;
 *    das Token wird vorher in `RunTokens` angemeldet, damit die Office-API den Lauf erkennt,
 *    sobald das CLI sie verbindet. Agent, Aufgabe und Lauftyp kommen aus `run.started`.
 * 2. **Ausgabe:** `run.output` liefert das Rohprotokoll (`stream-json`) in Ausschnitten. Jede
 *    Zeile geht durch den Parser aus P04 in die Auswertung aus P07: Gedankenblasen entstehen
 *    während des Laufs, nicht erst am Ende.
 * 3. **Ende:** Meldet der Supervisor `ended` und kommt nichts mehr nach, schließt die Auswertung
 *    den Lauf mit `run.finished` ab, und das Token wird zurückgezogen. Kennt der Supervisor den
 *    Lauf nicht (`unknown`, etwa nach Ablauf der Aufbewahrung), gilt er als ohne Ergebnis beendet.
 *
 * Neustart des Office: Der Fortschritt liegt nur im Speicher. Nach einem Neustart beginnt jeder
 * offene Lauf wieder bei Offset 0, und das Token wird erneut abgeholt (der Supervisor liefert
 * dasselbe). Das ist sicher, weil jedes Ereignis der Auswertung einen Idempotenzschlüssel aus
 * Lauf-ID und laufender Nummer trägt: Gleicher Inhalt wird nicht doppelt geschrieben.
 *
 * Fehler: Scheitert ein Abruf beim Supervisor, bleibt der Stand des Laufs, und der nächste
 * Durchlauf versucht es noch einmal; beide Aufrufe sind wiederholbar. Scheitert die Auswertung
 * selbst, beginnt der Lauf im nächsten Durchlauf von vorn. Ein Fehler hält die anderen Läufe nicht
 * auf.
 *
 * Takt: `poll` gleich nach jedem Durchlauf des Planers aufrufen, der einen Lauf zugelassen hat,
 * sonst in festem Abstand. Holt das Office das Token nicht innerhalb von `tokenWaitSeconds` ab,
 * beendet der Supervisor den Lauf ungestartet.
 */

/** Zugriff auf Token und Ausgabe der Läufe, im Betrieb `supervisorRunAccess` (P02). */
export interface RunAccess {
  token(runId: string): Promise<IpcResult<"run.token">>;
  output(runId: string, offset: number): Promise<IpcResult<"run.output">>;
}

/** Wie der Supervisor das Ende gemeldet hat. Nur zur Anzeige, nicht im Ereignisprotokoll. */
export interface RunEndReport {
  reason: string;
  exitCode: number | null;
  /** Aus `ergebnis.json` des Containers (P12), nicht vertrauenswürdig. */
  finishedBy: "normal" | "lease" | "stopp" | null;
  /** Das Rohprotokoll hatte seine Obergrenze erreicht; danach Angekommenes fehlt. */
  truncated: boolean;
}

export interface FollowResult {
  /** Läufe, deren Token in diesem Durchlauf angemeldet wurde. */
  registered: string[];
  /** Abgeschlossene Läufe. `end` ist `null`, wenn der Supervisor den Lauf nicht kannte. */
  finished: { run: RunRecord; end: RunEndReport | null }[];
  failed: { runId: string; error: string }[];
}

export interface RunFollowerOptions {
  office: Office;
  access: RunAccess;
  /** Dieselbe Instanz, die die Office-API prüft. */
  tokens: RunTokens;
  /**
   * Höchstzahl Ausschnitte je Lauf und Durchlauf, damit ein langer Lauf die anderen nicht
   * aufhält. [Annahme: 16, also bis 2 MiB bei 128 KiB je Ausschnitt]
   */
  maxSlicesPerPoll?: number;
  /** Jedes gelesene Ereignis, z. B. für eine Live-Anzeige. */
  onEvent?: (runId: string, event: RunEvent) => void;
}

export const DEFAULT_MAX_SLICES_PER_POLL = 16;

interface Followed {
  info: RunInfo;
  /** `run.token` ist beantwortet; bei `started` ist das Token angemeldet. */
  tokenDone: boolean;
  offset: number;
  splitter: LineSplitter;
  collector: OutcomeCollector;
  evaluation: RunEvaluation;
}

/** Fehler der Auswertung. Danach beginnt der Lauf von vorn. */
class EvaluationFailure extends Error {
  override name = "EvaluationFailure";
}

export class RunFollower {
  private readonly office: Office;
  private readonly access: RunAccess;
  private readonly tokens: RunTokens;
  private readonly maxSlices: number;
  private readonly onEvent: RunFollowerOptions["onEvent"];
  private readonly followed = new Map<string, Followed>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: RunFollowerOptions) {
    const maxSlices = options.maxSlicesPerPoll ?? DEFAULT_MAX_SLICES_PER_POLL;
    if (!Number.isInteger(maxSlices) || maxSlices < 1) {
      throw new Error("maxSlicesPerPoll muss eine ganze Zahl ab 1 sein");
    }
    this.office = options.office;
    this.access = options.access;
    this.tokens = options.tokens;
    this.maxSlices = maxSlices;
    this.onEvent = options.onEvent;
  }

  /** Läufe, die gerade begleitet werden. */
  get following(): string[] {
    return [...this.followed.keys()];
  }

  /**
   * Ein Durchlauf über alle offenen Läufe. Wartet, bis ein laufender Durchlauf fertig ist: Zwei
   * gleichzeitige Durchläufe läsen dieselbe Ausgabe doppelt in dieselbe Auswertung.
   */
  poll(): Promise<FollowResult> {
    const next = this.queue.then(() => this.run());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run(): Promise<FollowResult> {
    const result: FollowResult = { registered: [], finished: [], failed: [] };
    this.office.sync();
    const state = this.office.state;
    const open = state.runStarts().filter((s) => state.run(s.runId) === undefined);
    const openIds = new Set(open.map((s) => s.runId));
    // Inzwischen anderswo abgeschlossen: nicht mehr folgen, Token zurückziehen.
    for (const runId of [...this.followed.keys()]) {
      if (!openIds.has(runId)) {
        this.followed.delete(runId);
        this.tokens.revoke(runId);
      }
    }
    for (const start of open) {
      const entry = this.followed.get(start.runId) ?? this.begin(start);
      try {
        await this.step(entry, result);
      } catch (error) {
        if (error instanceof EvaluationFailure) {
          this.followed.delete(start.runId);
        }
        result.failed.push({ runId: start.runId, error: message(error) });
      }
    }
    return result;
  }

  private begin(start: RunStart): Followed {
    const info = runInfo(start);
    const entry: Followed = {
      info,
      tokenDone: false,
      offset: 0,
      splitter: new LineSplitter(),
      collector: new OutcomeCollector(info.runId),
      evaluation: new RunEvaluation(this.office, info),
    };
    this.followed.set(info.runId, entry);
    return entry;
  }

  private async step(entry: Followed, result: FollowResult): Promise<void> {
    const { runId } = entry.info;
    if (!entry.tokenDone) {
      const answer = await this.access.token(runId);
      if (answer.state === "started" && !this.tokens.hasRun(runId)) {
        evaluating(() => {
          this.tokens.register(answer.officeToken, {
            runId,
            agentId: entry.info.agentId,
            taskId: entry.info.taskId,
            runType: entry.info.runType,
            expiresAt: new Date(answer.expiresAt),
          });
        });
        result.registered.push(runId);
      }
      // `ended` oder `unknown`: Der Lauf startet nicht mehr; was dazu kommt, sagt `run.output`.
      entry.tokenDone = true;
    }
    for (let slice = 0; slice < this.maxSlices; slice += 1) {
      const answer = await this.access.output(runId, entry.offset);
      if (answer.state === "unknown") {
        result.finished.push({ run: evaluating(() => this.finish(entry, false)), end: null });
        return;
      }
      if (answer.data !== "") {
        evaluating(() => {
          this.consume(entry, answer.data, answer.nextOffset);
        });
        continue;
      }
      if (answer.state === "ended") {
        const end: RunEndReport = { ...answer.end, truncated: answer.truncated };
        // Lease und Stopp-Kaskade meldet der Startprozess (P12); dann gilt der Lauf als
        // abgebrochen, auch wenn noch eine Ergebnisnachricht kam.
        const aborted = end.finishedBy === "lease" || end.finishedBy === "stopp";
        result.finished.push({ run: evaluating(() => this.finish(entry, aborted)), end });
      }
      return;
    }
  }

  private consume(entry: Followed, data: string, nextOffset: number): void {
    if (nextOffset <= entry.offset) {
      throw new Error(
        `run.output: Offset rückt nicht vor (${String(entry.offset)} → ${String(nextOffset)})`,
      );
    }
    entry.offset = nextOffset;
    for (const line of entry.splitter.push(data)) {
      this.emit(entry, line);
    }
  }

  private emit(entry: Followed, line: string): void {
    for (const event of parseLine(line)) {
      entry.collector.add(event);
      entry.evaluation.add(event);
      this.onEvent?.(entry.info.runId, event);
    }
  }

  private finish(entry: Followed, aborted: boolean): RunRecord {
    for (const line of entry.splitter.end()) {
      this.emit(entry, line);
    }
    const { runId } = entry.info;
    const record = entry.evaluation.finish(entry.collector.finish(aborted));
    this.followed.delete(runId);
    this.tokens.revoke(runId);
    return record;
  }
}

/** Führt einen Schritt der Auswertung aus; ein Fehler darin setzt den Lauf zurück. */
function evaluating<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new EvaluationFailure(message(error), { cause: error });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
