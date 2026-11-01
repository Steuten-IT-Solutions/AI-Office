import { CEO_ID } from "../domain/agent.ts";
import { DomainError, type Office } from "../domain/office.ts";
import { Reader, ValidationError } from "../domain/validation.ts";
import type { JsonValue } from "../events/canonical-json.ts";
import type { RunGrant } from "./run-tokens.ts";

/**
 * Werkzeuge der Office-API (P08, plan.md Kap. 5.4, 7.3): `send_message`, `create_task`,
 * `delegate`, `handover`, `escalate`. Jedes Werkzeug ruft genau einen Befehl des Domänenmodells.
 *
 * Wer handelt, steht im Office-Token (`RunGrant`), nie in den Argumenten. Alle Prüfungen hier
 * dienen dem Komfort (E22). Sicherheitsrelevant ist von diesen Werkzeugen nur die Eskalation an
 * den CEO; die prüft der Supervisor (`EscalationGate`, Kap. 4.6).
 */

/** Höchstzahl Eskalationen je Agent und Kalendertag (UTC). [Annahme: 3] */
export const MAX_ESCALATIONS_PER_DAY = 3;

/** Prüfung des Supervisors für Eskalationen an den CEO (Kap. 4.6). Kommt mit P02. */
export interface EscalationGate {
  /** `null` erlaubt die Eskalation, sonst der Grund der Ablehnung. */
  checkEscalationToCeo(request: {
    runId: string;
    agentId: string;
    text: string;
  }): Promise<string | null>;
}

export interface ToolContext {
  office: Office;
  grant: RunGrant;
  idempotencyKey: string;
  gate: EscalationGate;
  /** Weisung aus E46: Nur der COO schreibt dem CEO. Standard: aus. */
  ceoViaCooOnly: () => boolean;
  now: Date;
}

export interface ToolOutput {
  text: string;
  structured: Record<string, JsonValue>;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
  run: (context: ToolContext, args: Reader) => ToolOutput | Promise<ToolOutput>;
}

/** Fehler, den das Modell selbst beheben kann. Wird als Werkzeugergebnis mit `isError` gemeldet. */
export class ToolError extends Error {
  override name = "ToolError";
}

const ID = { type: "string", description: "ID" };
const EVENT_ID = { type: "string", format: "uuid" };

function schema(
  properties: Record<string, JsonValue>,
  required: string[],
): Record<string, JsonValue> {
  return { type: "object", properties, required, additionalProperties: false };
}

/** Optionaler Wert: fehlend oder `null` wird `null`. */
function optional(r: Reader, key: string): unknown {
  return r.raw(key) ?? null;
}

/** Prüft nur die Form der Argumente. Inhaltlich prüft der Befehl des Domänenmodells. */
function args(r: Reader, ...keys: string[]): Reader {
  r.only(...keys);
  if (r.issues.length > 0) {
    throw new ValidationError("Argumente", r.issues);
  }
  return r;
}

const sendMessage: ToolDefinition = {
  name: "send_message",
  title: "Nachricht senden",
  description:
    "Nachricht an einen Agenten oder den CEO (`ceo`). Art `auftrag` (Empfänger soll etwas tun), `frage` (soll antworten) oder `info` (weckt niemanden). Optional mit Bezug auf eine Aufgabe oder eine Nachricht bzw. Eskalation, auf die du antwortest.",
  inputSchema: schema(
    {
      toId: { ...ID, description: "Empfänger: Agenten-ID oder `ceo`" },
      kind: { type: "string", enum: ["auftrag", "frage", "info"] },
      text: { type: "string", maxLength: 20_000 },
      taskId: { ...EVENT_ID, description: "Bezug auf eine Aufgabe" },
      replyToId: { ...EVENT_ID, description: "Antwort auf diese Nachricht oder Eskalation" },
    },
    ["toId", "kind", "text"],
  ),
  run(context, raw) {
    const r = args(raw, "toId", "kind", "text", "taskId", "replyToId");
    const { office, grant } = context;
    const toId = r.raw("toId");
    if (toId === CEO_ID && context.ceoViaCooOnly() && grant.agentId !== office.cooId()) {
      throw new ToolError(
        "An den CEO schreibt nach Weisung des CEO nur der COO (E46). Schreib dem COO.",
      );
    }
    const message = office.sendMessage(
      grant.agentId,
      {
        toId: toId as string,
        kind: r.raw("kind") as "info",
        text: r.raw("text") as string,
        taskId: optional(r, "taskId") as string | null,
        replyToId: optional(r, "replyToId") as string | null,
      },
      { runId: grant.runId, idempotencyKey: context.idempotencyKey },
    );
    return {
      text: `Nachricht ${message.id} an ${message.toId} gesendet.`,
      structured: { messageId: message.id },
    };
  },
};

const createTask: ToolDefinition = {
  name: "create_task",
  title: "Aufgabe anlegen",
  description:
    "Neue Aufgabe mit Titel, Beschreibung und Lauftyp. `werkbank` braucht ein Repo (`owner/name`) und einen Bearbeiter mit Werkbank. Optional Bearbeiter und übergeordnete Aufgabe.",
  inputSchema: schema(
    {
      title: { type: "string", maxLength: 200 },
      description: { type: "string", maxLength: 20_000 },
      runType: { type: "string", enum: ["buero", "werkbank", "recherche"] },
      repo: {
        type: "string",
        description: "Nur für werkbank, z. B. Steuten-IT-Solutions/AI-Office",
      },
      assigneeId: { ...ID, description: "Bearbeiter (Agenten-ID)" },
      parentTaskId: { ...EVENT_ID, description: "Übergeordnete Aufgabe" },
    },
    ["title", "description", "runType"],
  ),
  run(context, raw) {
    const r = args(raw, "title", "description", "runType", "repo", "assigneeId", "parentTaskId");
    const task = context.office.createTask(
      context.grant.agentId,
      {
        title: r.raw("title") as string,
        description: r.raw("description") as string,
        runType: r.raw("runType") as "buero",
        repo: optional(r, "repo") as string | null,
        assigneeId: optional(r, "assigneeId") as string | null,
        parentTaskId: optional(r, "parentTaskId") as string | null,
      },
      { runId: context.grant.runId, idempotencyKey: context.idempotencyKey },
    );
    return { text: `Aufgabe ${task.id} angelegt.`, structured: { taskId: task.id } };
  },
};

const delegate: ToolDefinition = {
  name: "delegate",
  title: "Aufgabe delegieren",
  description:
    "Aufgabe an einen anderen Agenten geben. Eine `werkbank`-Aufgabe nur an jemanden mit Werkbank.",
  inputSchema: schema(
    { taskId: EVENT_ID, assigneeId: { ...ID, description: "Neuer Bearbeiter (Agenten-ID)" } },
    ["taskId", "assigneeId"],
  ),
  run(context, raw) {
    const r = args(raw, "taskId", "assigneeId");
    const task = context.office.delegateTask(
      context.grant.agentId,
      r.raw("taskId") as string,
      r.raw("assigneeId") as string,
      { runId: context.grant.runId, idempotencyKey: context.idempotencyKey },
    );
    return {
      text: `Aufgabe ${task.id} liegt jetzt bei ${String(task.assigneeId)}.`,
      structured: { taskId: task.id, assigneeId: task.assigneeId },
    };
  },
};

const handover: ToolDefinition = {
  name: "handover",
  title: "Übergabenotiz schreiben",
  description:
    "Übergabenotiz zum Stand deiner Aufgabe, höchstens 2.000 Zeichen. Pflicht am Ende jedes Laufs. Ohne `taskId` gilt die Aufgabe dieses Laufs.",
  inputSchema: schema(
    {
      note: { type: "string", maxLength: 2_000 },
      taskId: { ...EVENT_ID, description: "Standard: Aufgabe dieses Laufs" },
    },
    ["note"],
  ),
  run(context, raw) {
    const r = args(raw, "note", "taskId");
    const taskId = (optional(r, "taskId") as string | null) ?? context.grant.taskId;
    if (taskId === null) {
      throw new ToolError("Dieser Lauf hat keine Aufgabe. Gib `taskId` an.");
    }
    const task = context.office.writeHandover(
      context.grant.agentId,
      taskId,
      r.raw("note") as string,
      { runId: context.grant.runId, idempotencyKey: context.idempotencyKey },
    );
    return { text: `Übergabenotiz zu ${task.id} gespeichert.`, structured: { taskId: task.id } };
  },
};

const escalate: ToolDefinition = {
  name: "escalate",
  title: "Eskalieren",
  description: `Problem melden, das du nicht selbst lösen kannst. Die Eskalation geht an den COO, die des COO an den CEO. Höchstens ${String(MAX_ESCALATIONS_PER_DAY)} je Tag. Ohne Antwort geht sie nach einem Timeout eine Ebene höher.`,
  inputSchema: schema(
    {
      text: {
        type: "string",
        maxLength: 20_000,
        description: "Problem, bisherige Versuche, was du brauchst",
      },
      taskId: { ...EVENT_ID, description: "Bezug auf eine Aufgabe" },
    },
    ["text"],
  ),
  async run(context, raw) {
    const r = args(raw, "text", "taskId");
    const { office, grant } = context;
    const text = r.raw("text");
    const repeated = office.hasCommitted(context.idempotencyKey);
    if (!repeated) {
      const day = context.now.toISOString().slice(0, 10);
      const today = office.state
        .escalations({ fromId: grant.agentId })
        .filter((e) => e.occurredAt.slice(0, 10) === day).length;
      if (today >= MAX_ESCALATIONS_PER_DAY) {
        throw new ToolError(
          `Du hast heute schon ${String(today)} Eskalationen gemeldet. Schreib deinem Vorgesetzten eine Nachricht.`,
        );
      }
      if (office.escalationTarget(grant.agentId) === CEO_ID && typeof text === "string") {
        const reason = await context.gate.checkEscalationToCeo({
          runId: grant.runId,
          agentId: grant.agentId,
          text,
        });
        if (reason !== null) {
          throw new ToolError(`Der Supervisor lehnt die Eskalation an den CEO ab: ${reason}`);
        }
      }
    }
    const escalation = office.escalate(
      grant.agentId,
      { text: text as string, taskId: optional(r, "taskId") as string | null },
      { runId: grant.runId, idempotencyKey: context.idempotencyKey },
    );
    return {
      text: `Eskalation ${escalation.id} an ${escalation.toId} gemeldet.`,
      structured: { escalationId: escalation.id, toId: escalation.toId },
    };
  },
};

/** Alle Werkzeuge in fester Reihenfolge (für stabile `tools/list`-Antworten). */
export const TOOLS: readonly ToolDefinition[] = [
  sendMessage,
  createTask,
  delegate,
  handover,
  escalate,
];

/** Fehler, die das Modell selbst beheben kann, als Text; alles andere ist ein Serverfehler. */
export function toolErrorText(error: unknown): string | null {
  if (error instanceof ToolError || error instanceof DomainError) {
    return error.message;
  }
  if (error instanceof ValidationError) {
    return error.message;
  }
  return null;
}
