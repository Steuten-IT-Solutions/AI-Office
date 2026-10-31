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

export const DOMAIN_EVENT_TYPES: readonly EventType<unknown>[] = [
  AGENT_HIRED,
  AGENT_PROFILE_CHANGED,
  TASK_CREATED,
  TASK_DELEGATED,
  TASK_STATUS_CHANGED,
  MESSAGE_SENT,
];
