import { canonicalJson, type JsonValue } from "../events/canonical-json.ts";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { EventType } from "../events/event-types.ts";
import type { RunType } from "../llm/runner.ts";
import { CEO_ID, parseAgentProfile, type AgentProfile } from "./agent.ts";
import type { Building } from "./building.ts";
import {
  AGENT_HIRED,
  AGENT_PROFILE_CHANGED,
  ESCALATION_RAISED,
  MESSAGE_SENT,
  RUN_FINISHED,
  RUN_THOUGHT,
  TASK_CREATED,
  TASK_DELEGATED,
  TASK_HANDOVER,
  TASK_STATUS_CHANGED,
  parseEscalationRaised,
  parseMessageSent,
  parseRunFinished,
  parseRunThought,
  parseTaskCreated,
  parseTaskDelegated,
  parseTaskHandover,
  parseTaskStatusChanged,
  type RunFinished,
} from "./events.ts";
import type { Escalation, Message, MessageKind } from "./message.ts";
import { OfficeState, type RunRecord, type Thought } from "./office-state.ts";
import type { Task, TaskStatus } from "./task.ts";
import { ValidationError, type Parsed } from "./validation.ts";

/**
 * Befehle auf dem Domänenmodell. Jeder Befehl prüft gegen den aktuellen Zustand, schreibt genau
 * ein Ereignis und wendet es an. Die Werkzeuge der Office-API (P08) rufen diese Befehle auf.
 *
 * Annahme wie in Kap. 3.4: ein Schreiber je Datenbankdatei. Vor jedem Befehl liest `sync()`
 * Ereignisse nach, die eine andere Instanz geschrieben hat; gleichzeitige Schreiber schützt das
 * nicht vollständig.
 */

/** Ein Befehl verstößt gegen die Regeln des Domänenmodells. */
export class DomainError extends Error {
  override name = "DomainError";
}

export interface CommandOptions {
  runId?: string;
  /** Lauf-ID + Sequenznummer des Werkzeugaufrufs (Kap. 5.7). */
  idempotencyKey?: string;
}

export interface NewTask {
  title: string;
  description: string;
  runType: RunType;
  repo?: string | null;
  assigneeId?: string | null;
  parentTaskId?: string | null;
}

export interface NewMessage {
  toId: string;
  kind: MessageKind;
  text: string;
  taskId?: string | null;
  replyToId?: string | null;
}

const PAGE_SIZE = 1000;

function valid<T>(subject: string, result: Parsed<T>): T {
  if (!result.ok) {
    throw new ValidationError(subject, result.issues);
  }
  return result.value;
}

export interface OfficeOptions {
  /** Uhr für den Zeitstempel neuer Ereignisse. Standard: Systemzeit. In Tests fest. */
  now?: () => Date;
}

export class Office {
  readonly state: OfficeState;
  /** Dieselbe Uhr nutzen Ereignisse und Prüfungen, die vom Datum abhängen (z. B. Tagesgrenzen). */
  readonly now: () => Date;
  private readonly store: EventStore;

  private constructor(store: EventStore, building: Building, options: OfficeOptions) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.state = new OfficeState(building);
    this.sync();
  }

  /** Baut den Zustand aus dem gesamten Ereignisprotokoll auf. */
  static open(store: EventStore, building: Building, options: OfficeOptions = {}): Office {
    return new Office(store, building, options);
  }

  /** Liest neue Ereignisse nach. */
  sync(): void {
    for (;;) {
      const events = this.store.read({ afterSeq: this.state.lastSeq, limit: PAGE_SIZE });
      for (const event of events) {
        this.state.apply(event);
      }
      if (events.length < PAGE_SIZE) {
        return;
      }
    }
  }

  hireAgent(actor: string, profile: AgentProfile, options: CommandOptions = {}): AgentProfile {
    const checked = valid("Profil", parseAgentProfile(profile));
    this.commit(AGENT_HIRED, actor, { profile: checked }, options);
    return this.state.agent(checked.id) as AgentProfile;
  }

  /** Neue Version eines Profils. `version` muss die aktuelle Version + 1 sein. */
  changeProfile(actor: string, profile: AgentProfile, options: CommandOptions = {}): AgentProfile {
    const checked = valid("Profil", parseAgentProfile(profile));
    this.commit(AGENT_PROFILE_CHANGED, actor, { profile: checked }, options);
    return this.state.agent(checked.id) as AgentProfile;
  }

  createTask(actor: string, input: NewTask, options: CommandOptions = {}): Task {
    const payload = valid(
      "Aufgabe",
      parseTaskCreated({
        title: input.title,
        description: input.description,
        runType: input.runType,
        repo: input.repo ?? null,
        assigneeId: input.assigneeId ?? null,
        parentTaskId: input.parentTaskId ?? null,
      }),
    );
    const event = this.commit(TASK_CREATED, actor, payload, options);
    return this.state.task(event.id) as Task;
  }

  delegateTask(
    actor: string,
    taskId: string,
    assigneeId: string,
    options: CommandOptions = {},
  ): Task {
    const payload = valid("Delegation", parseTaskDelegated({ taskId, assigneeId }));
    this.commit(TASK_DELEGATED, actor, payload, options);
    return this.state.task(taskId) as Task;
  }

  changeTaskStatus(
    actor: string,
    taskId: string,
    status: TaskStatus,
    note: string | null = null,
    options: CommandOptions = {},
  ): Task {
    const payload = valid("Statuswechsel", parseTaskStatusChanged({ taskId, status, note }));
    this.commit(TASK_STATUS_CHANGED, actor, payload, options);
    return this.state.task(taskId) as Task;
  }

  sendMessage(actor: string, input: NewMessage, options: CommandOptions = {}): Message {
    const payload = valid(
      "Nachricht",
      parseMessageSent({
        toId: input.toId,
        kind: input.kind,
        text: input.text,
        taskId: input.taskId ?? null,
        replyToId: input.replyToId ?? null,
      }),
    );
    const event = this.commit(MESSAGE_SENT, actor, payload, options);
    return this.state.message(event.id) as Message;
  }

  /**
   * Empfänger einer Eskalation (Kap. 5.4, E47): der COO; für den COO selbst und solange es
   * keinen COO gibt der CEO. COO ist der Agent mit der Rolle `COO`, bei mehreren der erste nach ID.
   */
  escalationTarget(actor: string): string {
    const coo = this.cooId();
    return coo === null || coo === actor ? CEO_ID : coo;
  }

  /** Der Agent mit der Rolle `COO`, bei mehreren der erste nach ID, sonst `null`. */
  cooId(): string | null {
    const coo = this.state
      .agents()
      .filter((a) => a.role === "COO")
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    return coo?.id ?? null;
  }

  /** Ob unter diesem Idempotenzschlüssel schon ein Ereignis geschrieben wurde. */
  hasCommitted(idempotencyKey: string): boolean {
    return this.store.findByIdempotencyKey(idempotencyKey) !== undefined;
  }

  /** Eskalation auf dem Weg aus Kap. 5.4. Den Empfänger wählt nicht der Agent. */
  escalate(
    actor: string,
    input: { text: string; taskId?: string | null },
    options: CommandOptions = {},
  ): Escalation {
    // Erst nachlesen: Den COO kann eine andere Instanz eingestellt oder geändert haben, und die
    // frühere Eskalation einer Wiederholung kann von dort stammen.
    this.sync();
    // Wiederholung: Der Empfänger bleibt der von damals, auch wenn es inzwischen einen anderen
    // COO gibt. Text, Aufgabe und Handelnder müssen trotzdem übereinstimmen.
    const existing =
      options.idempotencyKey === undefined
        ? undefined
        : this.store.findByIdempotencyKey(options.idempotencyKey);
    const stored = existing === undefined ? undefined : this.state.escalation(existing.id);
    const payload = valid(
      "Eskalation",
      parseEscalationRaised({
        toId: stored?.toId ?? this.escalationTarget(actor),
        text: input.text,
        taskId: input.taskId ?? null,
      }),
    );
    const event = this.commit(ESCALATION_RAISED, actor, payload, options);
    return this.state.escalation(event.id) as Escalation;
  }

  /**
   * Übergabenotiz zur Aufgabe (`handover`, Kap. 5.2). `auto` setzt nur die Auswertung, die dann
   * als `system` handelt.
   */
  writeHandover(
    actor: string,
    taskId: string,
    note: string,
    options: CommandOptions & { auto?: boolean } = {},
  ): Task {
    const payload = valid(
      "Übergabenotiz",
      parseTaskHandover({ taskId, note, auto: options.auto ?? false }),
    );
    this.commit(TASK_HANDOVER, actor, payload, options);
    return this.state.task(taskId) as Task;
  }

  /** Gedankenblase eines Laufs. Braucht die Lauf-ID. */
  recordThought(actor: string, text: string, options: CommandOptions): Thought {
    const payload = valid("Gedankenblase", parseRunThought({ text }));
    const event = this.commit(RUN_THOUGHT, actor, payload, options);
    return this.state.thoughts(event.runId ?? undefined).find((t) => t.id === event.id) as Thought;
  }

  /** Schließt einen Lauf ab und bucht seine Kosten (Kap. 6). Braucht die Lauf-ID. */
  recordRunFinished(actor: string, input: RunFinished, options: CommandOptions): RunRecord {
    const payload = valid("Laufabschluss", parseRunFinished(input));
    const event = this.commit(RUN_FINISHED, actor, payload, options);
    return this.state.run(event.runId as string) as RunRecord;
  }

  /**
   * Prüft und schreibt ein Ereignis. Ein wiederholter Aufruf mit demselben Idempotenzschlüssel
   * und demselben Inhalt liefert das bereits geschriebene Ereignis, ohne erneut zu prüfen.
   */
  private commit<T>(
    eventType: EventType<T>,
    actor: string,
    payload: T,
    options: CommandOptions,
  ): StoredEvent {
    this.sync();
    const json = JSON.parse(canonicalJson(payload)) as JsonValue;
    if (options.idempotencyKey !== undefined) {
      const existing = this.store.findByIdempotencyKey(options.idempotencyKey);
      if (existing !== undefined) {
        if (
          existing.type !== eventType.type ||
          existing.actor !== actor ||
          canonicalJson(existing.payload) !== canonicalJson(json)
        ) {
          throw new DomainError(
            `Idempotenzschlüssel ${options.idempotencyKey} wurde mit anderem Inhalt wiederverwendet`,
          );
        }
        return existing;
      }
    }
    const reason = this.state.check({
      type: eventType.type,
      actor,
      payload: json,
      runId: options.runId ?? null,
    });
    if (reason !== null) {
      throw new DomainError(reason);
    }
    const event = this.store.append({
      type: eventType.type,
      version: eventType.version,
      actor,
      payload: json,
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      occurredAt: this.now(),
    });
    this.state.apply(event);
    return event;
  }
}
