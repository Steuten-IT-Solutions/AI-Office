import type { RunOutcome, RunType } from "../llm/runner.ts";
import type { RunEvent } from "../llm/stream-json.ts";
import { CEO_ID } from "./agent.ts";
import { MAX_HANDOVER_CHARS, MAX_TEXT_CHARS, MAX_THOUGHT_CHARS } from "./events.ts";
import { mayWake } from "./message.ts";
import { DomainError, type Office } from "./office.ts";
import type { RunRecord } from "./office-state.ts";
import { truncateText } from "./validation.ts";

/**
 * Auswertung eines Laufs (P07, plan.md Kap. 3.3 Nr. 5 und 6): macht aus der Ausgabe Ereignisse.
 *
 * - Jeder Textblock des Agenten wird eine Gedankenblase (`run.thought`), gekürzt.
 * - Fehlt am Ende die Übergabenotiz zur Aufgabe, erzeugt die Auswertung sie aus den Ereignissen
 *   des Laufs (`task.handover` mit `auto`, Kap. 5.2).
 * - Zuletzt `run.finished` mit Kosten fürs Hauptbuch (Kap. 6) und dem Postfach-Zeiger.
 *
 * Sprechblasen entstehen sonst über die Office-API (`send_message`, P08). Eine Ausnahme ist die
 * **Antwort an den CEO (E62):** Lag im Postfach des Laufs eine neue Nachricht des CEO und hat
 * der Agent dem CEO im Lauf nichts geschrieben, wird der Schlusstext seine Antwort im Chat. Sonst
 * stünde sie nur als Gedankenblase in der Zeitleiste, und der CEO bekäme keine Rückmeldung.
 * Denkblöcke (`thinking`) werden nicht übernommen: Sie sind nicht für Dritte formuliert und
 * vergrößern das Protokoll. [Annahme]
 *
 * Alle Ereignisse tragen einen Idempotenzschlüssel aus Lauf-ID und laufender Nummer. Eine
 * wiederholte Auswertung desselben Laufs schreibt deshalb nichts doppelt.
 */

/** Höchstzahl Gedankenblasen je Lauf; weitere werden nur gezählt. [Annahme: 20] */
export const MAX_THOUGHTS_PER_RUN = 20;
/** Anteil der letzten Antwort an einer automatischen Übergabenotiz. [Annahme: 800 Zeichen] */
export const AUTO_HANDOVER_ANSWER_CHARS = 800;

/** Was die Auswertung über den Lauf wissen muss. Kommt vom Planer (P06). */
export interface RunInfo {
  runId: string;
  agentId: string;
  taskId: string | null;
  runType: RunType;
  /** Modell-Alias aus dem Auftrag. */
  model: string;
  /** Aus dem Kontextaufbau (`RunContext.inboxUpToSeq`). */
  inboxUpToSeq: number;
}

export class RunEvaluation {
  private readonly office: Office;
  private readonly info: RunInfo;
  private readonly tools = new Map<string, number>();
  private thoughtCount = 0;
  private lastText: string | null = null;
  private finished = false;

  constructor(office: Office, info: RunInfo) {
    this.office = office;
    this.info = info;
  }

  /** Gedankenblasen, die wegen `MAX_THOUGHTS_PER_RUN` nicht geschrieben wurden. */
  get omittedThoughts(): number {
    return Math.max(this.thoughtCount - MAX_THOUGHTS_PER_RUN, 0);
  }

  /** Nimmt ein Ereignis des Laufs auf. Passt als `onEvent` für `LlmRunner.run`. */
  add(event: RunEvent): void {
    if (this.finished) {
      throw new DomainError(`Lauf ${this.info.runId} ist bereits ausgewertet`);
    }
    if (event.kind === "tool_use") {
      this.tools.set(event.name, (this.tools.get(event.name) ?? 0) + 1);
      return;
    }
    if (event.kind !== "text") {
      return;
    }
    const text = event.text.trim();
    if (text === "") {
      return;
    }
    this.lastText = text;
    this.thoughtCount += 1;
    if (this.thoughtCount <= MAX_THOUGHTS_PER_RUN) {
      this.office.recordThought(this.info.agentId, truncateText(text, MAX_THOUGHT_CHARS), {
        runId: this.info.runId,
        idempotencyKey: `${this.info.runId}:thought:${String(this.thoughtCount)}`,
      });
    }
  }

  /** Schließt die Auswertung ab: ggf. automatische Übergabenotiz, dann `run.finished`. */
  finish(outcome: RunOutcome): RunRecord {
    const { runId, agentId, taskId } = this.info;
    if (outcome.runId !== runId) {
      throw new DomainError(`Ergebnis gehört zu Lauf ${outcome.runId}, nicht zu ${runId}`);
    }
    this.finished = true;
    const toolCalls = [...this.tools.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (outcome.exit === "completed") {
      this.answerCeo(outcome);
    }

    const task = taskId === null ? undefined : this.office.state.task(taskId);
    if (task !== undefined && task.handover?.runId !== runId) {
      this.office.writeHandover("system", task.id, this.autoHandover(outcome, toolCalls), {
        auto: true,
        runId,
        idempotencyKey: `${runId}:handover:auto`,
      });
    }

    return this.office.recordRunFinished(
      agentId,
      {
        taskId,
        runType: this.info.runType,
        model: this.info.model,
        exit: outcome.exit,
        resultSubtype: outcome.resultSubtype,
        totalCostUsd: outcome.totalCostUsd,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        cacheReadInputTokens: outcome.usage.cacheReadInputTokens,
        cacheCreationInputTokens: outcome.usage.cacheCreationInputTokens,
        numTurns: outcome.numTurns,
        rateLimitStatus: outcome.rateLimitStatus,
        invalidLines: outcome.invalidLines,
        toolCalls,
        inboxUpToSeq: this.info.inboxUpToSeq,
      },
      { runId, idempotencyKey: `${runId}:finished` },
    );
  }

  /**
   * Antwort an den CEO aus dem Schlusstext (E62). Nur nach einem abgeschlossenen Lauf, denn nur
   * dann gilt das Postfach als gelesen. Maßgeblich sind die Nachrichten des CEO, die der Lauf neu
   * im Postfach hatte (nach dem bisherigen Lesezeiger bis `inboxUpToSeq`); eine `info` zählt
   * nicht, sie weckt auch niemanden (E32). Hat der Agent dem CEO im Lauf selbst geschrieben,
   * bleibt es dabei. Die Antwort ist eine `info` mit Bezug auf die letzte dieser Nachrichten.
   */
  private answerCeo(outcome: RunOutcome): void {
    const { runId, agentId, taskId, inboxUpToSeq } = this.info;
    const state = this.office.state;
    const since = state.inboxReadSeq(agentId);
    const fromCeo = state
      .messages({ toId: agentId, afterSeq: since })
      .filter((m) => m.fromId === CEO_ID && m.seq <= inboxUpToSeq && mayWake(m.kind));
    const asked = fromCeo.at(-1);
    if (asked === undefined) {
      return;
    }
    const answered = state
      .messages({ toId: CEO_ID, afterSeq: since })
      .some((m) => m.fromId === agentId && m.runId === runId);
    if (answered) {
      return;
    }
    const answer = (outcome.finalText ?? "").trim() || (this.lastText ?? "");
    if (answer === "") {
      return;
    }
    this.office.sendMessage(
      agentId,
      {
        toId: CEO_ID,
        kind: "info",
        text: truncateText(answer, MAX_TEXT_CHARS),
        taskId: asked.taskId ?? taskId,
        replyToId: asked.id,
      },
      { runId, idempotencyKey: `${runId}:antwort-ceo` },
    );
  }

  /**
   * Notiz aus den Ereignissen des Laufs: Ende, Werkzeuge, letzte Antwort. Die vorige Notiz hängt
   * an, damit ein abgebrochener Lauf den Stand nicht verliert; gekürzt wird am Ende.
   */
  private autoHandover(outcome: RunOutcome, toolCalls: { name: string; count: number }[]): string {
    const exit =
      outcome.resultSubtype === null ? outcome.exit : `${outcome.exit} (${outcome.resultSubtype})`;
    const tools =
      toolCalls.length === 0
        ? "keine"
        : toolCalls.map((t) => `${t.name} ${String(t.count)}×`).join(", ");
    const answer = outcome.finalText?.trim() ?? this.lastText;
    const lines = [
      `Automatisch erzeugt: Lauf ${this.info.runId} hat keine Übergabenotiz geschrieben.`,
      `Ende: ${exit}. Züge: ${String(outcome.numTurns)}. Werkzeuge: ${tools}.`,
      `Letzte Antwort: ${answer === null || answer === "" ? "keine" : truncateText(answer, AUTO_HANDOVER_ANSWER_CHARS)}`,
    ];
    const previous =
      this.info.taskId === null ? null : this.office.state.task(this.info.taskId)?.handover;
    if (previous !== undefined && previous !== null) {
      lines.push("", "Übergabenotiz davor:", previous.note);
    }
    return truncateText(lines.join("\n"), MAX_HANDOVER_CHARS);
  }
}
