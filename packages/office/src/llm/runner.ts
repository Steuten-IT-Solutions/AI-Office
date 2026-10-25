import type { ModelCost, RunEvent, TokenUsage } from "./stream-json.ts";

/**
 * Adapter für den Antrieb der Agenten (plan.md Kap. 3.4, 5.8).
 *
 * Das Office baut nur den Auftrag. Den CLI-Aufruf baut und startet im Betrieb ausschließlich der
 * Supervisor (E25). In Tests ersetzt der `FakeRunner` jeden echten Lauf (E23).
 */
export type RunType = "werkbank" | "buero" | "recherche";

export interface RunRequest {
  runId: string;
  agentId: string;
  runType: RunType;
  /** Modell-Alias (`haiku`, `sonnet`, `opus`). Die Richtlinie prüft der Supervisor. */
  model: string;
  /** Kontext und Aufgabe als Text. Daten, keine Konfiguration. */
  prompt: string;
  maxTurns: number;
  maxBudgetUsd: number;
}

export type RunExit =
  /** Ergebnisnachricht mit `success`. */
  | "completed"
  /** Ergebnisnachricht mit Fehler (z. B. `error_max_turns`, `error_max_budget_usd`). */
  | "error"
  /** Abgebrochen über das AbortSignal (Notaus, Zeitgrenze). */
  | "aborted"
  /** Strom endete ohne Ergebnisnachricht (Absturz). */
  | "no_result";

export interface RunOutcome {
  runId: string;
  exit: RunExit;
  /** Untertyp der Ergebnisnachricht, sonst `null`. */
  resultSubtype: string | null;
  finalText: string | null;
  totalCostUsd: number;
  usage: TokenUsage;
  modelUsage: Record<string, ModelCost>;
  numTurns: number;
  /** Schlechtester gemeldeter Status des Kontingents während des Laufs. */
  rateLimitStatus: "allowed" | "allowed_warning" | "rejected" | null;
  /** Anzahl nicht lesbarer Zeilen; über 0 deutet auf eine geänderte CLI-Ausgabe hin (R9). */
  invalidLines: number;
}

export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

export interface LlmRunner {
  run(request: RunRequest, options?: RunOptions): Promise<RunOutcome>;
}

const RATE_ORDER = { allowed: 0, allowed_warning: 1, rejected: 2 } as const;

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

/** Fasst die Ereignisse eines Laufs zusammen. Grundlage für Hauptbuch und Admission. */
export class OutcomeCollector {
  private result: Extract<RunEvent, { kind: "result" }> | null = null;
  private rate: RunOutcome["rateLimitStatus"] = null;
  private invalid = 0;

  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  add(event: RunEvent): void {
    if (event.kind === "result") {
      this.result = event;
    } else if (event.kind === "invalid") {
      this.invalid += 1;
    } else if (event.kind === "rate_limit" && event.status !== "unknown") {
      if (this.rate === null || RATE_ORDER[event.status] > RATE_ORDER[this.rate]) {
        this.rate = event.status;
      }
    }
  }

  finish(aborted: boolean): RunOutcome {
    const result = this.result;
    let exit: RunExit;
    if (aborted) {
      exit = "aborted";
    } else if (result === null) {
      exit = "no_result";
    } else {
      exit = result.isError ? "error" : "completed";
    }
    return {
      runId: this.runId,
      exit,
      resultSubtype: result?.subtype ?? null,
      finalText: result?.text ?? null,
      totalCostUsd: result?.totalCostUsd ?? 0,
      usage: result?.usage ?? EMPTY_USAGE,
      modelUsage: result?.modelUsage ?? {},
      numTurns: result?.numTurns ?? 0,
      rateLimitStatus: this.rate,
      invalidLines: this.invalid,
    };
  }
}
