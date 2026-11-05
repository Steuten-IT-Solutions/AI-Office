/**
 * Zusammenfassung eines Laufs aus der Ausgabe von `claude -p --output-format stream-json`.
 *
 * Geparst wird mit dem Parser des Office (P07, packages/office/src/llm/stream-json.ts). So prüft
 * jeder Spike nebenbei, ob dieser Parser mit der echten Ausgabe des gepinnten CLI zurechtkommt:
 * Unbekannte Typen und ungültige Zeilen stehen im Bericht (R9).
 */
import {
  parseLine,
  type RunEvent,
  type TokenUsage,
} from "../../../packages/office/src/llm/stream-json.ts";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RunSummary {
  model: string | null;
  claudeCodeVersion: string | null;
  mcpServers: { name: string; status: string }[];
  tools: string[];
  toolUses: { name: string; command: string | null; filePath: string | null }[];
  toolResults: { isError: boolean; content: string }[];
  resultSubtype: string | null;
  isError: boolean | null;
  resultText: string | null;
  errors: string[];
  totalCostUsd: number | null;
  usage: TokenUsage | null;
  numTurns: number | null;
  permissionDenials: number;
  /** Ereignisse je Art; unbekannte als `unbekannt:<type>/<subtype>` (S2e). */
  eventCounts: Record<string, number>;
  rateLimits: { status: string; resetsAt: number | null; utilization: number | null }[];
  apiRetries: { error: string; errorStatus: number | null }[];
  invalidLines: number;
}

/**
 * Welche Messfelder die Ergebniszeile wirklich enthält. Der Office-Parser setzt fehlendes
 * `total_cost_usd` auf 0 und fehlende `usage` auf Nullwerte; für Messungen muss „fehlt“ aber
 * `null` bleiben.
 */
function resultFieldsPresent(line: string): { cost: boolean; usage: boolean } | null {
  try {
    const raw = JSON.parse(line) as unknown;
    if (!isObject(raw) || raw["type"] !== "result") {
      return null;
    }
    const cost = raw["total_cost_usd"];
    return {
      cost: typeof cost === "number" && Number.isFinite(cost),
      usage: isObject(raw["usage"]),
    };
  } catch {
    return null;
  }
}

function eventKey(event: RunEvent): string {
  if (event.kind === "unknown") {
    return `unbekannt:${event.type}${event.subtype === null ? "" : `/${event.subtype}`}`;
  }
  return event.kind;
}

export function summarize(stdout: string): RunSummary {
  const summary: RunSummary = {
    model: null,
    claudeCodeVersion: null,
    mcpServers: [],
    tools: [],
    toolUses: [],
    toolResults: [],
    resultSubtype: null,
    isError: null,
    resultText: null,
    errors: [],
    totalCostUsd: null,
    usage: null,
    numTurns: null,
    permissionDenials: 0,
    eventCounts: {},
    rateLimits: [],
    apiRetries: [],
    invalidLines: 0,
  };
  for (const line of stdout.split("\n")) {
    const present = resultFieldsPresent(line);
    for (const event of parseLine(line)) {
      const key = eventKey(event);
      summary.eventCounts[key] = (summary.eventCounts[key] ?? 0) + 1;
      switch (event.kind) {
        case "init":
          summary.model = event.model;
          summary.claudeCodeVersion = event.claudeCodeVersion;
          summary.mcpServers = event.mcpServers;
          summary.tools = event.tools;
          break;
        case "tool_use":
          summary.toolUses.push({
            name: event.name,
            command:
              isObject(event.input) && typeof event.input["command"] === "string"
                ? event.input["command"]
                : null,
            filePath:
              isObject(event.input) && typeof event.input["file_path"] === "string"
                ? event.input["file_path"]
                : null,
          });
          break;
        case "tool_result":
          summary.toolResults.push({ isError: event.isError, content: event.content });
          break;
        case "rate_limit":
          summary.rateLimits.push({
            status: event.status,
            resetsAt: event.resetsAt,
            utilization: event.utilization,
          });
          break;
        case "api_retry":
          summary.apiRetries.push({ error: event.error, errorStatus: event.errorStatus });
          break;
        case "invalid":
          summary.invalidLines++;
          break;
        case "result":
          summary.resultSubtype = event.subtype;
          summary.isError = event.isError;
          summary.resultText = event.text;
          summary.errors = event.errors;
          summary.totalCostUsd = present?.cost === true ? event.totalCostUsd : null;
          summary.usage = present?.usage === true ? event.usage : null;
          summary.numTurns = event.numTurns;
          summary.permissionDenials = event.permissionDenials;
          break;
        default:
          break;
      }
    }
  }
  return summary;
}

/** Lauf erfolgreich: Ergebnis `success` ohne Fehlerkennzeichen. */
export function succeeded(summary: RunSummary): boolean {
  return summary.resultSubtype === "success" && summary.isError === false;
}
