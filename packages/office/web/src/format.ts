/**
 * Reine Funktionen für Texte des Webinterface (P10): Zeit, Kosten, Beschreibung der Ereignisse.
 * Kein DOM; die Ergebnisse gehen über `dom.ts` nur als Text ins DOM.
 *
 * Payloads kommen aus dem Ereignisprotokoll. Unbekannte Typen sind dort ungeprüft gespeichert
 * (P03), deshalb liest jede Funktion hier defensiv und rechnet mit beliebigen Werten.
 */

/** Höchstlänge eines Texts in der Zeitleiste. Der volle Text steht im Chat. */
export const TIMELINE_TEXT_CHARS = 280;

/** `owner/name` nach den Zeichenregeln von GitHub, wie im Gateway (`views.ts`). */
const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export interface Lookup {
  /** Anzeigename einer Agenten-ID, `ceo` oder `system`. */
  agentName(id: string): string;
  /** Titel einer Aufgabe, sonst `null`. */
  taskTitle(id: string): string | null;
}

/** Ein Eintrag aus `GET /api/timeline`. */
export interface TimelineEvent {
  seq: number;
  id: string;
  type: string;
  version: number;
  actor: string;
  runId: string | null;
  occurredAt: string;
  payload: unknown;
  runCostUsd: number | null;
}

export interface EventText {
  /** Wer gehandelt hat (bei `run.started` der Agent, nicht `system`). */
  agentId: string;
  text: string;
  level: "normal" | "wichtig" | "unbekannt";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Feld eines Payloads als Zeichenkette, sonst `""`. */
export function field(payload: unknown, key: string): string {
  const value = record(payload)?.[key];
  return typeof value === "string" ? value : "";
}

export function numberField(payload: unknown, key: string): number | null {
  const value = record(payload)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Kürzt einen Text auf höchstens `max` Zeichen, mit „…“ am Ende. */
export function shorten(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * Kosten in US-Dollar. Kleine Beträge mit vier Nachkommastellen, damit einzelne Läufe sichtbar
 * bleiben.
 */
export function formatUsd(usd: number): string {
  const digits = Math.abs(usd) < 1 ? 4 : 2;
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(usd);
}

export function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value)} %`;
}

/** Zeitpunkt in der Zeitzone des Browsers, oder in `timeZone` (für Tests). */
export function formatTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "short",
    timeStyle: "medium",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(date);
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  auftrag: "Auftrag",
  frage: "Frage",
  info: "Info",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  offen: "offen",
  in_arbeit: "in Arbeit",
  blockiert: "blockiert",
  erledigt: "erledigt",
  abgebrochen: "abgebrochen",
};

const EXIT_LABELS: Readonly<Record<string, string>> = {
  completed: "abgeschlossen",
  error: "mit Fehler",
  aborted: "abgebrochen",
  no_result: "ohne Ergebnis",
};

const CI_LABELS: Readonly<Record<string, string>> = {
  success: "CI grün",
  failure: "CI rot",
  pending: "CI läuft",
  none: "keine CI",
};

function label(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? (labels[value] as string) : value;
}

export function kindLabel(kind: string): string {
  return label(KIND_LABELS, kind);
}

export function ciLabel(ci: string): string {
  return label(CI_LABELS, ci);
}

function task(lookup: Lookup, taskId: string): string {
  const title = taskId === "" ? null : lookup.taskTitle(taskId);
  return title === null ? "einer Aufgabe" : `„${shorten(title, 80)}“`;
}

/**
 * Beschreibt ein Ereignis für die Zeitleiste (AK 11: Agent, Kosten, Zeitpunkt). Die Kosten stehen
 * in `runCostUsd`, der Zeitpunkt in `occurredAt`; beides setzt die Ansicht dazu.
 */
export function describeEvent(event: TimelineEvent, lookup: Lookup): EventText {
  const p = event.payload;
  const name = (id: string): string => lookup.agentName(id);
  const short = (text: string): string => shorten(text, TIMELINE_TEXT_CHARS);
  const by = (text: string, level: EventText["level"] = "normal"): EventText => ({
    agentId: event.actor,
    text,
    level,
  });
  switch (event.type) {
    case "agent.hired": {
      const profile = record(p)?.["profile"];
      return by(`stellt ${field(profile, "name") || "jemanden"} ein (${field(profile, "role")})`);
    }
    case "agent.profile_changed": {
      const profile = record(p)?.["profile"];
      return by(`ändert das Profil von ${field(profile, "name") || "jemandem"}`);
    }
    case "task.created": {
      const assignee = field(p, "assigneeId");
      return by(
        `legt Aufgabe „${shorten(field(p, "title"), 120)}“ an` +
          (assignee === "" ? "" : `, zugewiesen an ${name(assignee)}`),
      );
    }
    case "task.delegated":
      return by(
        `gibt ${task(lookup, field(p, "taskId"))} an ${name(field(p, "assigneeId"))} weiter`,
      );
    case "task.status_changed": {
      const note = field(p, "note");
      return by(
        `setzt ${task(lookup, field(p, "taskId"))} auf ${label(STATUS_LABELS, field(p, "status"))}` +
          (note === "" ? "" : `: ${short(note)}`),
      );
    }
    case "task.handover":
      return by(`Übergabenotiz zu ${task(lookup, field(p, "taskId"))}: ${short(field(p, "note"))}`);
    case "message.sent":
      return by(
        `${kindLabel(field(p, "kind"))} an ${name(field(p, "toId"))}: ${short(field(p, "text"))}`,
      );
    case "escalation.raised":
      return by(`eskaliert an ${name(field(p, "toId"))}: ${short(field(p, "text"))}`, "wichtig");
    case "escalation.answered":
      return by("beantwortet eine Eskalation");
    case "run.thought":
      return by(`denkt: ${short(field(p, "text"))}`);
    case "run.started":
      return {
        agentId: field(p, "agentId") || event.actor,
        text: `Lauf beginnt (${field(p, "runType")}, ${field(p, "model")})`,
        level: "normal",
      };
    case "run.finished": {
      const exit = field(p, "exit");
      const turns = numberField(p, "numTurns");
      return by(
        `Lauf endet ${label(EXIT_LABELS, exit)}` +
          (turns === null ? "" : `, ${String(turns)} Runden`) +
          `, Modell ${field(p, "model")}`,
        exit === "completed" ? "normal" : "wichtig",
      );
    }
    default:
      return by(`Ereignis ${event.type} (Version ${String(event.version)})`, "unbekannt");
  }
}

/** Link zum PR in GitHub, gebaut aus Repo und Nummer. Nie eine URL aus den Daten übernehmen. */
export function githubPullUrl(repo: unknown, number: unknown): string | null {
  if (typeof repo !== "string" || !REPO_PATTERN.test(repo)) {
    return null;
  }
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    return null;
  }
  return `https://github.com/${repo}/pull/${String(number)}`;
}
