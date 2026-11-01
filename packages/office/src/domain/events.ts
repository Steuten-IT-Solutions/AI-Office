import type { EventType } from "../events/event-types.ts";
import type { RunType } from "../llm/runner.ts";
import { parseAgentProfile, type AgentProfile } from "./agent.ts";
import { MESSAGE_KINDS, type MessageKind } from "./message.ts";
import { TASK_STATUSES, type TaskStatus } from "./task.ts";
import { Reader, parsed, type Parsed } from "./validation.ts";

/**
 * Ereignistypen des Domänenmodells, alle in Version 1. Neue Felder kommen nach Expand/Contract
 * als neue Version hinzu (E24). Wer gehandelt hat, steht im Feld `actor` des Ereignisses, nicht
 * im Payload.
 *
 * IDs von Aufgaben und Nachrichten sind die IDs ihrer Ereignisse. Damit enthält der Payload
 * keine zufälligen Werte, und ein wiederholter Aufruf mit demselben Idempotenzschlüssel
 * (Lauf-ID + Sequenz, Kap. 5.7) ergibt denselben Payload.
 */

export const RUN_TYPES: readonly RunType[] = ["werkbank", "buero", "recherche"];

/** Obergrenzen gegen ausufernde Payloads. [Annahme: Werte im Betrieb justieren] */
export const MAX_TITLE_CHARS = 200;
export const MAX_TEXT_CHARS = 20_000;
/** Übergabenotiz: „begrenzte Länge“ (Kap. 5.2). [Annahme: 2.000 Zeichen] */
export const MAX_HANDOVER_CHARS = 2_000;
/** Gedankenblase: „gekürzter“ Text (Kap. 3.3). [Annahme: 500 Zeichen] */
export const MAX_THOUGHT_CHARS = 500;

export interface AgentHired {
  profile: AgentProfile;
}

export interface AgentProfileChanged {
  profile: AgentProfile;
}

export interface TaskCreated {
  title: string;
  description: string;
  runType: RunType;
  /** Repo für `werkbank`-Aufgaben, z. B. `Steuten-IT-Solutions/AI-Office`. */
  repo: string | null;
  assigneeId: string | null;
  parentTaskId: string | null;
}

export interface TaskDelegated {
  taskId: string;
  assigneeId: string;
}

export interface TaskStatusChanged {
  taskId: string;
  status: TaskStatus;
  note: string | null;
}

/** Übergabenotiz zu einer Aufgabe (Kap. 5.2), geschrieben mit `handover` oder automatisch. */
export interface TaskHandover {
  taskId: string;
  note: string;
  /** `true`, wenn die Auswertung sie erzeugt hat, weil der Lauf keine geschrieben hat. */
  auto: boolean;
}

/** Gedankenblase: gekürzter tatsächlicher Text eines Laufs (Kap. 3.3 Nr. 5, E1). */
export interface RunThought {
  text: string;
}

export const RUN_EXITS = ["completed", "error", "aborted", "no_result"] as const;
export const RATE_LIMIT_STATUSES = ["allowed", "allowed_warning", "rejected"] as const;

/** Abschluss eines Laufs mit Kosten fürs Hauptbuch (Kap. 6). Handelnder ist der Agent. */
export interface RunFinished {
  taskId: string | null;
  runType: RunType;
  model: string;
  exit: (typeof RUN_EXITS)[number];
  resultSubtype: string | null;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  numTurns: number;
  rateLimitStatus: (typeof RATE_LIMIT_STATUSES)[number] | null;
  invalidLines: number;
  /** Werkzeugaufrufe je Werkzeugname. */
  toolCalls: { name: string; count: number }[];
  /**
   * Bis zu dieser Sequenznummer hat der Lauf das Postfach im Kontext gesehen. Der Zeiger rückt
   * nur bei `completed` vor; sonst sieht der nächste Lauf dieselben Nachrichten noch einmal.
   */
  inboxUpToSeq: number;
}

/**
 * Eskalation (Kap. 5.4, E47): an den COO, Eskalationen des COO an den CEO. Den Empfänger legt
 * der Befehl fest, nicht der Agent. Eine Antwort ist eine Nachricht mit `replyToId` auf die
 * Eskalation.
 */
export interface EscalationRaised {
  toId: string;
  text: string;
  taskId: string | null;
}

export interface MessageSent {
  toId: string;
  kind: MessageKind;
  text: string;
  taskId: string | null;
  replyToId: string | null;
}

/** Ereignis-IDs sind UUIDs (siehe `EventStore.append`). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `owner/name` nach den Zeichenregeln von GitHub. */
const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

function eventRef(r: Reader, key: string, optional: true): string | null;
function eventRef(r: Reader, key: string, optional: false): string;
function eventRef(r: Reader, key: string, optional: boolean): string | null {
  const value = r.raw(key);
  if ((value === undefined || value === null) && optional) {
    return null;
  }
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    r.issues.push(`${key}: Ereignis-ID erwartet`);
    return "";
  }
  return value;
}

function profilePayload(payload: unknown): Parsed<{ profile: AgentProfile }> {
  const r = new Reader(payload).only("profile");
  const result = parseAgentProfile(r.raw("profile"));
  if (!result.ok) {
    r.issues.push(...result.issues);
    return { ok: false, issues: r.issues };
  }
  return parsed(r, { profile: result.value });
}

export function parseTaskCreated(payload: unknown): Parsed<TaskCreated> {
  const r = new Reader(payload).only(
    "title",
    "description",
    "runType",
    "repo",
    "assigneeId",
    "parentTaskId",
  );
  const value: TaskCreated = {
    title: r.string("title", { maxLength: MAX_TITLE_CHARS }),
    description: r.string("description", { maxLength: MAX_TEXT_CHARS }),
    runType: r.oneOf("runType", RUN_TYPES),
    repo: r.optionalString("repo"),
    assigneeId: r.optionalId("assigneeId"),
    parentTaskId: eventRef(r, "parentTaskId", true),
  };
  if (value.repo !== null && !REPO_PATTERN.test(value.repo)) {
    r.issues.push("repo: owner/name erwartet");
  }
  if (value.runType === "werkbank" && value.repo === null) {
    r.issues.push("repo: Aufgaben vom Lauftyp werkbank brauchen ein Repo (Kap. 5.7)");
  }
  if (value.runType !== "werkbank" && value.repo !== null) {
    r.issues.push("repo: nur Aufgaben vom Lauftyp werkbank haben eine Arbeitskopie (Kap. 5.7)");
  }
  return parsed(r, value);
}

export function parseTaskDelegated(payload: unknown): Parsed<TaskDelegated> {
  const r = new Reader(payload).only("taskId", "assigneeId");
  return parsed(r, { taskId: eventRef(r, "taskId", false), assigneeId: r.id("assigneeId") });
}

export function parseTaskStatusChanged(payload: unknown): Parsed<TaskStatusChanged> {
  const r = new Reader(payload).only("taskId", "status", "note");
  const note = r.optionalString("note");
  if (note !== null && note.length > MAX_TEXT_CHARS) {
    r.issues.push(`note: höchstens ${String(MAX_TEXT_CHARS)} Zeichen`);
  }
  return parsed(r, {
    taskId: eventRef(r, "taskId", false),
    status: r.oneOf("status", TASK_STATUSES),
    note,
  });
}

export function parseMessageSent(payload: unknown): Parsed<MessageSent> {
  const r = new Reader(payload).only("toId", "kind", "text", "taskId", "replyToId");
  return parsed(r, {
    toId: r.id("toId"),
    kind: r.oneOf("kind", MESSAGE_KINDS),
    text: r.string("text", { maxLength: MAX_TEXT_CHARS }),
    taskId: eventRef(r, "taskId", true),
    replyToId: eventRef(r, "replyToId", true),
  });
}

export function parseEscalationRaised(payload: unknown): Parsed<EscalationRaised> {
  const r = new Reader(payload).only("toId", "text", "taskId");
  return parsed(r, {
    toId: r.id("toId"),
    text: r.string("text", { maxLength: MAX_TEXT_CHARS }),
    taskId: eventRef(r, "taskId", true),
  });
}

export function parseTaskHandover(payload: unknown): Parsed<TaskHandover> {
  const r = new Reader(payload).only("taskId", "note", "auto");
  return parsed(r, {
    taskId: eventRef(r, "taskId", false),
    note: r.string("note", { maxLength: MAX_HANDOVER_CHARS }),
    auto: r.boolean("auto"),
  });
}

export function parseRunThought(payload: unknown): Parsed<RunThought> {
  const r = new Reader(payload).only("text");
  return parsed(r, { text: r.string("text", { maxLength: MAX_THOUGHT_CHARS }) });
}

const COUNT_MAX = Number.MAX_SAFE_INTEGER;

export function parseRunFinished(payload: unknown): Parsed<RunFinished> {
  const r = new Reader(payload).only(
    "taskId",
    "runType",
    "model",
    "exit",
    "resultSubtype",
    "totalCostUsd",
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "numTurns",
    "rateLimitStatus",
    "invalidLines",
    "toolCalls",
    "inboxUpToSeq",
  );
  const rate = r.raw("rateLimitStatus");
  return parsed(r, {
    taskId: eventRef(r, "taskId", true),
    runType: r.oneOf("runType", RUN_TYPES),
    model: r.string("model", { maxLength: 100 }),
    exit: r.oneOf("exit", RUN_EXITS),
    resultSubtype: r.optionalString("resultSubtype"),
    totalCostUsd: r.number("totalCostUsd", 0, 1_000_000),
    inputTokens: r.integer("inputTokens", 0, COUNT_MAX),
    outputTokens: r.integer("outputTokens", 0, COUNT_MAX),
    cacheReadInputTokens: r.integer("cacheReadInputTokens", 0, COUNT_MAX),
    cacheCreationInputTokens: r.integer("cacheCreationInputTokens", 0, COUNT_MAX),
    numTurns: r.integer("numTurns", 0, COUNT_MAX),
    rateLimitStatus: rate === null ? null : r.oneOf("rateLimitStatus", RATE_LIMIT_STATUSES),
    invalidLines: r.integer("invalidLines", 0, COUNT_MAX),
    toolCalls: r.objects("toolCalls").map((t) => {
      t.only("name", "count");
      return {
        name: t.string("name", { maxLength: 200 }),
        count: t.integer("count", 1, COUNT_MAX),
      };
    }),
    inboxUpToSeq: r.integer("inboxUpToSeq", 0, COUNT_MAX),
  });
}

function eventType<T>(type: string, parse: (payload: unknown) => Parsed<T>): EventType<T> {
  return {
    type,
    version: 1,
    parse(payload) {
      const result = parse(payload);
      return result.ok ? result.value : null;
    },
  };
}

export const AGENT_HIRED = eventType<AgentHired>("agent.hired", profilePayload);
export const AGENT_PROFILE_CHANGED = eventType<AgentProfileChanged>(
  "agent.profile_changed",
  profilePayload,
);
export const TASK_CREATED = eventType("task.created", parseTaskCreated);
export const TASK_DELEGATED = eventType("task.delegated", parseTaskDelegated);
export const TASK_STATUS_CHANGED = eventType("task.status_changed", parseTaskStatusChanged);
export const MESSAGE_SENT = eventType("message.sent", parseMessageSent);
export const TASK_HANDOVER = eventType("task.handover", parseTaskHandover);
export const RUN_THOUGHT = eventType("run.thought", parseRunThought);
export const RUN_FINISHED = eventType("run.finished", parseRunFinished);
export const ESCALATION_RAISED = eventType("escalation.raised", parseEscalationRaised);

export const DOMAIN_EVENT_TYPES: readonly EventType<unknown>[] = [
  AGENT_HIRED,
  AGENT_PROFILE_CHANGED,
  TASK_CREATED,
  TASK_DELEGATED,
  TASK_STATUS_CHANGED,
  MESSAGE_SENT,
  TASK_HANDOVER,
  RUN_THOUGHT,
  RUN_FINISHED,
  ESCALATION_RAISED,
];
