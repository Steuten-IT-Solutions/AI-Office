/**
 * Kontingent aus der Antwort auf `/usage` lesen (Spike S2a).
 *
 * Plan Fakt 7 nennt für den `SDKUsageReport` Zeilen je Zeitfenster mit `kind` (z. B. `session`,
 * `weekly_all`, `weekly_scoped`), `percent` und `resets_at`. Ob `/usage` im Print-Modus geht und
 * wie die Antwort dort aussieht, ist nicht dokumentiert (Headless-Doku, geprüft 05.11.2026).
 * Deshalb sucht diese Datei an zwei Stellen:
 *  1. strukturiert: in jedem JSON-Objekt der Ausgabe nach Objekten mit einer Prozentzahl und
 *     einer Bezeichnung des Fensters,
 *  2. als Text: Zeilen mit „<Bezeichnung> … <Zahl> %“ im Ergebnistext.
 */
import { isObject } from "./stream.ts";

export interface UsageRow {
  /** Bezeichnung des Fensters, z. B. `session` oder `weekly_all`; aus Text normalisiert. */
  kind: string;
  percent: number;
  resetsAt: string | null;
  /** Wo die Zeile gefunden wurde: JSON-Pfad oder `text`. */
  source: string;
}

const PERCENT_KEYS = ["percent", "percentage", "used_percent", "utilization"];
const KIND_KEYS = ["kind", "window", "type", "name", "label"];
const RESET_KEYS = ["resets_at", "resetsAt", "reset_at", "resets"];

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in o) {
      return o[key];
    }
  }
  return undefined;
}

export function findStructuredRows(value: unknown, path = "$"): UsageRow[] {
  const rows: UsageRow[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => rows.push(...findStructuredRows(item, `${path}[${String(i)}]`)));
    return rows;
  }
  if (!isObject(value)) {
    return rows;
  }
  const percent = pick(value, PERCENT_KEYS);
  const kind = pick(value, KIND_KEYS);
  if (typeof percent === "number" && Number.isFinite(percent) && typeof kind === "string") {
    const reset = pick(value, RESET_KEYS);
    rows.push({
      kind,
      // `utilization` kann ein Anteil 0..1 sein [Annahme]; dann in Prozent umrechnen.
      percent: "utilization" in value && percent <= 1 ? percent * 100 : percent,
      resetsAt: typeof reset === "string" || typeof reset === "number" ? String(reset) : null,
      source: path,
    });
  }
  for (const [key, child] of Object.entries(value)) {
    rows.push(...findStructuredRows(child, `${path}.${key}`));
  }
  return rows;
}

/** Normalisiert eine Bezeichnung aus dem Text, z. B. „Current week (all models)“ → `current_week_all_models`. */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function findTextRows(text: string): UsageRow[] {
  const rows: UsageRow[] = [];
  let label: string | null = null;
  let last: UsageRow | null = null;
  for (const line of text.split("\n")) {
    const match = /(\d+(?:[.,]\d+)?)\s*%/.exec(line);
    if (match === null) {
      const trimmed = line.trim();
      if (/^resets?\b/i.test(trimmed)) {
        // „Resets …“ steht in der Zeile nach dem Fenster [Annahme].
        if (last !== null && last.resetsAt === null) {
          last.resetsAt = trimmed;
        }
      } else if (trimmed !== "") {
        label = trimmed;
      }
      continue;
    }
    const before = line
      .slice(0, match.index)
      .replace(/[█░▓▒■□|[\]:•\-–—]+/g, " ")
      .trim();
    const kind = normalizeLabel(before !== "" ? before : (label ?? ""));
    last = {
      kind: kind === "" ? "unbekannt" : kind,
      percent: Number((match[1] ?? "0").replace(",", ".")),
      resetsAt: null,
      source: "text",
    };
    rows.push(last);
  }
  return rows;
}

/** Strukturierte Zeilen haben Vorrang; sonst die aus dem Text. Doppelte `kind` nur einmal. */
export function usageRows(messages: unknown[], resultText: string | null): UsageRow[] {
  // rate_limit_event trägt eine eigene Auslastung je Limit; die gehört nicht zu /usage (S2e).
  const structured = messages.flatMap((m, i) =>
    isObject(m) && m["type"] === "rate_limit_event" ? [] : findStructuredRows(m, `$[${String(i)}]`),
  );
  const rows = structured.length > 0 ? structured : findTextRows(resultText ?? "");
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.kind)) {
      return false;
    }
    seen.add(r.kind);
    return true;
  });
}

/** Differenz je Fenster (nachher − vorher) in Prozentpunkten. */
export function delta(before: UsageRow[], after: UsageRow[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const a of after) {
    const b = before.find((r) => r.kind === a.kind);
    if (b !== undefined) {
      result[a.kind] = Math.round((a.percent - b.percent) * 100) / 100;
    }
  }
  return result;
}

/**
 * Fenster, die zwischen zwei Messungen zurückgesetzt wurden: Der Wert ist gefallen, oder die
 * strukturierte Reset-Zeit hat sich geändert. Über einen Reset hinweg ist `delta` sinnlos
 * (z. B. 80 % → 1 % ergäbe −79 Punkte). Reset-Zeiten aus dem Text zählen nicht, weil sie relativ
 * sein können („Resets in 3 h“) [Annahme].
 */
export function resetKinds(before: UsageRow[], after: UsageRow[]): string[] {
  return after
    .filter((a) => {
      const b = before.find((r) => r.kind === a.kind);
      if (b === undefined) {
        return false;
      }
      const structured = a.source !== "text" && b.source !== "text";
      const resetMoved =
        structured && a.resetsAt !== null && b.resetsAt !== null && a.resetsAt !== b.resetsAt;
      return a.percent < b.percent || resetMoved;
    })
    .map((a) => a.kind);
}

/**
 * Fenster für das Wochenlimit über alle Modelle: `weekly_all` laut Plan Fakt 7, sonst die erste
 * Bezeichnung mit „week“/„woche“ ohne Modellnamen [Annahme].
 */
export function weeklyKind(rows: UsageRow[]): string | null {
  const exact = rows.find((r) => r.kind === "weekly_all");
  if (exact !== undefined) {
    return exact.kind;
  }
  const loose = rows.find(
    (r) => /week|woche/.test(r.kind) && !/sonnet|opus|haiku|fable|scoped/.test(r.kind),
  );
  return loose?.kind ?? null;
}
