/**
 * Reine Funktionen für Texte des Webinterface (P10): Zeit, Kosten, Beschreibung der Ereignisse.
 * Kein DOM; die Ergebnisse gehen über `dom.js` nur als Text ins DOM.
 *
 * Payloads kommen aus dem Ereignisprotokoll. Unbekannte Typen sind dort ungeprüft gespeichert
 * (P03), deshalb liest jede Funktion hier defensiv und rechnet mit beliebigen Werten.
 */

/** Höchstlänge eines Texts in der Zeitleiste. Der volle Text steht im Chat. */
export const TIMELINE_TEXT_CHARS = 280;

/** `owner/name` nach den Zeichenregeln von GitHub, wie im Gateway (`views.ts`). */
const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * @typedef {object} Lookup
 * @property {(id: string) => string} agentName Anzeigename einer Agenten-ID, `ceo` oder `system`.
 * @property {(id: string) => string | null} taskTitle Titel einer Aufgabe, sonst `null`.
 */

/**
 * @typedef {object} TimelineEvent
 * @property {number} seq
 * @property {string} id
 * @property {string} type
 * @property {number} version
 * @property {string} actor
 * @property {string | null} runId
 * @property {string} occurredAt
 * @property {unknown} payload
 * @property {number | null} runCostUsd
 */

/**
 * @typedef {object} EventText
 * @property {string} agentId Wer gehandelt hat (bei `run.started` der Agent, nicht `system`).
 * @property {string} text
 * @property {"normal" | "wichtig" | "unbekannt"} level
 */

/**
 * Feld eines Payloads als Zeichenkette, sonst `""`.
 *
 * @param {unknown} payload
 * @param {string} key
 * @returns {string}
 */
export function field(payload, key) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "";
  }
  const value = /** @type {Record<string, unknown>} */ (payload)[key];
  return typeof value === "string" ? value : "";
}

/**
 * @param {unknown} payload
 * @param {string} key
 * @returns {number | null}
 */
export function numberField(payload, key) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const value = /** @type {Record<string, unknown>} */ (payload)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Kürzt einen Text auf höchstens `max` Zeichen, mit „…“ am Ende.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function shorten(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * Kosten in US-Dollar. Kleine Beträge mit vier Nachkommastellen, damit einzelne Läufe sichtbar
 * bleiben.
 *
 * @param {number} usd
 * @returns {string}
 */
export function formatUsd(usd) {
  const digits = Math.abs(usd) < 1 ? 4 : 2;
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(usd);
}

/**
 * @param {number} value
 * @returns {string}
 */
export function formatPercent(value) {
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value)} %`;
}

/**
 * Zeitpunkt in der Zeitzone des Browsers, oder in `timeZone` (für Tests).
 *
 * @param {string} iso
 * @param {string} [timeZone]
 * @returns {string}
 */
export function formatTime(iso, timeZone) {
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

/** @type {Readonly<Record<string, string>>} */
const KIND_LABELS = { auftrag: "Auftrag", frage: "Frage", info: "Info" };

/** @type {Readonly<Record<string, string>>} */
const STATUS_LABELS = {
  offen: "offen",
  in_arbeit: "in Arbeit",
  blockiert: "blockiert",
  erledigt: "erledigt",
  abgebrochen: "abgebrochen",
};

/** @type {Readonly<Record<string, string>>} */
const EXIT_LABELS = {
  completed: "abgeschlossen",
  error: "mit Fehler",
  aborted: "abgebrochen",
  no_result: "ohne Ergebnis",
};

/**
 * @param {Readonly<Record<string, string>>} labels
 * @param {string} value
 * @returns {string}
 */
function label(labels, value) {
  return Object.hasOwn(labels, value) ? /** @type {string} */ (labels[value]) : value;
}

/**
 * @param {string} kind
 * @returns {string}
 */
export function kindLabel(kind) {
  return label(KIND_LABELS, kind);
}

/**
 * @param {Lookup} lookup
 * @param {string} taskId
 * @returns {string}
 */
function task(lookup, taskId) {
  const title = taskId === "" ? null : lookup.taskTitle(taskId);
  return title === null ? "einer Aufgabe" : `„${shorten(title, 80)}“`;
}

/**
 * Beschreibt ein Ereignis für die Zeitleiste (AK 11: Agent, Kosten, Zeitpunkt). Die Kosten stehen
 * in `runCostUsd`, der Zeitpunkt in `occurredAt`; beides setzt die Ansicht dazu.
 *
 * @param {TimelineEvent} event
 * @param {Lookup} lookup
 * @returns {EventText}
 */
export function describeEvent(event, lookup) {
  const p = event.payload;
  const name = (/** @type {string} */ id) => lookup.agentName(id);
  const short = (/** @type {string} */ text) => shorten(text, TIMELINE_TEXT_CHARS);
  /** @type {(text: string, level?: EventText["level"]) => EventText} */
  const by = (text, level = "normal") => ({ agentId: event.actor, text, level });
  switch (event.type) {
    case "agent.hired": {
      const profile = /** @type {unknown} */ (
        typeof p === "object" && p !== null
          ? /** @type {Record<string, unknown>} */ (p)["profile"]
          : null
      );
      return by(`stellt ${field(profile, "name") || "jemanden"} ein (${field(profile, "role")})`);
    }
    case "agent.profile_changed": {
      const profile = /** @type {unknown} */ (
        typeof p === "object" && p !== null
          ? /** @type {Record<string, unknown>} */ (p)["profile"]
          : null
      );
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

/**
 * Link zum PR in GitHub, gebaut aus Repo und Nummer. Nie eine URL aus den Daten übernehmen.
 *
 * @param {unknown} repo
 * @param {unknown} number
 * @returns {string | null}
 */
export function githubPullUrl(repo, number) {
  if (typeof repo !== "string" || !REPO_PATTERN.test(repo)) {
    return null;
  }
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    return null;
  }
  return `https://github.com/${repo}/pull/${String(number)}`;
}

/** @type {Readonly<Record<string, string>>} */
const CI_LABELS = {
  success: "CI grün",
  failure: "CI rot",
  pending: "CI läuft",
  none: "keine CI",
};

/**
 * @param {string} ci
 * @returns {string}
 */
export function ciLabel(ci) {
  return label(CI_LABELS, ci);
}
