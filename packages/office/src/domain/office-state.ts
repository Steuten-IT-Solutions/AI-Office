import type { DecodedEvent } from "../events/event-types.ts";
import { EventRegistry } from "../events/event-types.ts";
import type { StoredEvent } from "../events/event-store.ts";
import { CEO_ID, allowedRunTypes, type AgentProfile } from "./agent.ts";
import { findRoom, type Building } from "./building.ts";
import {
  AGENT_HIRED,
  AGENT_PROFILE_CHANGED,
  DOMAIN_EVENT_TYPES,
  MESSAGE_SENT,
  RUN_FINISHED,
  RUN_THOUGHT,
  TASK_CREATED,
  TASK_DELEGATED,
  TASK_HANDOVER,
  TASK_STATUS_CHANGED,
  type MessageSent,
  type RunFinished,
  type RunThought,
  type TaskCreated,
  type TaskDelegated,
  type TaskHandover,
  type TaskStatusChanged,
} from "./events.ts";
import type { Message } from "./message.ts";
import { CLOSED_STATUSES, canTransition, isReopen, type Task } from "./task.ts";
import type { RunType } from "../llm/runner.ts";

/**
 * Projektion des Ereignisprotokolls auf den Zustand der Firma: Agenten, Aufgaben, Nachrichten.
 *
 * Der Zustand entsteht nur aus Ereignissen (Kap. 3.1 Nr. 2). Dieselben Regeln prüfen einen
 * Befehl vor dem Schreiben (`check`) und ein Ereignis beim Einlesen (`apply`). Ein Ereignis,
 * das gegen die Regeln verstößt (etwa aus einer anderen Office-Version), wird nicht angewandt,
 * sondern mit Grund in `skipped` vermerkt. Ereignistypen anderer Module ignoriert die Projektion.
 *
 * Nur `check` prüft gegen das Gebäude (Raum, Ausstattung). Das Gebäude kommt im MVP aus einer
 * Datendatei, nicht aus dem Protokoll; eine spätere Änderung dieser Datei darf beim Einlesen
 * keine Agenten verschwinden lassen.
 */

export interface SkippedEvent {
  seq: number;
  type: string;
  reason: string;
}

/** Ein Ereignis, wie es geschrieben werden soll, zur Prüfung vor dem Schreiben. */
export interface PendingEvent {
  type: string;
  actor: string;
  payload: unknown;
  runId?: string | null;
}

/** Ein abgeschlossener Lauf, Zeile im Hauptbuch (Kap. 6). */
export interface RunRecord extends RunFinished {
  runId: string;
  agentId: string;
  seq: number;
  occurredAt: string;
}

/** Gedankenblase eines Laufs für die Zeitleiste (Kap. 3.3 Nr. 5). */
export interface Thought {
  id: string;
  seq: number;
  occurredAt: string;
  agentId: string;
  runId: string;
  text: string;
}

const DOMAIN_TYPES = new Set<string>(DOMAIN_EVENT_TYPES.map((t) => t.type));

export function domainRegistry(): EventRegistry {
  const registry = new EventRegistry();
  for (const eventType of DOMAIN_EVENT_TYPES) {
    registry.register(eventType);
  }
  return registry;
}

export class OfficeState {
  readonly building: Building;
  /** Höchste eingelesene Sequenznummer. */
  lastSeq = 0;
  readonly skipped: SkippedEvent[] = [];

  private readonly registry = domainRegistry();
  /** Alle Versionen je Agent, die letzte ist die gültige. */
  private readonly profiles = new Map<string, AgentProfile[]>();
  private readonly taskById = new Map<string, Task>();
  private readonly messageList: Message[] = [];
  private readonly messageById = new Map<string, Message>();
  private readonly thoughtList: Thought[] = [];
  private readonly runById = new Map<string, RunRecord>();
  /** Je Agent: bis zu dieser Sequenznummer hat ein abgeschlossener Lauf das Postfach gelesen. */
  private readonly inboxRead = new Map<string, number>();

  constructor(building: Building) {
    this.building = building;
  }

  agent(id: string): AgentProfile | undefined {
    return this.profiles.get(id)?.at(-1);
  }

  agents(): AgentProfile[] {
    return [...this.profiles.values()].map((versions) => versions.at(-1) as AgentProfile);
  }

  /** Alle Versionen eines Profils, älteste zuerst. */
  profileHistory(id: string): AgentProfile[] {
    return [...(this.profiles.get(id) ?? [])];
  }

  task(id: string): Task | undefined {
    return this.taskById.get(id);
  }

  tasks(): Task[] {
    return [...this.taskById.values()];
  }

  message(id: string): Message | undefined {
    return this.messageById.get(id);
  }

  /** Nachrichten in Reihenfolge des Protokolls, optional nur ab einer Sequenznummer. */
  messages(options: { toId?: string; afterSeq?: number } = {}): Message[] {
    return this.messageList.filter(
      (m) =>
        (options.toId === undefined || m.toId === options.toId) && m.seq > (options.afterSeq ?? 0),
    );
  }

  /** Gedankenblasen in Reihenfolge des Protokolls, optional nur eines Laufs. */
  thoughts(runId?: string): Thought[] {
    return this.thoughtList.filter((t) => runId === undefined || t.runId === runId);
  }

  run(runId: string): RunRecord | undefined {
    return this.runById.get(runId);
  }

  /** Abgeschlossene Läufe in Reihenfolge des Protokolls. */
  runs(): RunRecord[] {
    return [...this.runById.values()];
  }

  /**
   * Sequenznummer, bis zu der der Agent sein Postfach gelesen hat. Neue Nachrichten sind die mit
   * höherer Nummer. Der Zeiger rückt nur mit einem Lauf vor, der `completed` endete.
   */
  inboxReadSeq(agentId: string): number {
    return this.inboxRead.get(agentId) ?? 0;
  }

  /** Agent oder CEO. */
  isParticipant(id: string): boolean {
    return id === CEO_ID || this.profiles.has(id);
  }

  /** Prüft ein geplantes Ereignis gegen den aktuellen Zustand. Liefert den Grund oder `null`. */
  check(pending: PendingEvent): string | null {
    const eventType = DOMAIN_EVENT_TYPES.find((t) => t.type === pending.type);
    if (eventType === undefined) {
      return `${pending.type} ist kein Ereignistyp des Domänenmodells`;
    }
    const payload = eventType.parse(pending.payload, eventType.version);
    if (payload === null) {
      return "Payload entspricht nicht dem Schema";
    }
    const reason = this.checkDecoded(pending.type, pending.actor, payload, pending.runId ?? null);
    if (reason !== null) {
      return reason;
    }
    if (pending.type === AGENT_HIRED.type || pending.type === AGENT_PROFILE_CHANGED.type) {
      return this.checkRoom((payload as { profile: AgentProfile }).profile);
    }
    return null;
  }

  apply(event: StoredEvent): void {
    if (event.seq <= this.lastSeq) {
      return;
    }
    this.lastSeq = event.seq;
    if (!DOMAIN_TYPES.has(event.type)) {
      return;
    }
    const decoded: DecodedEvent<unknown> = this.registry.decode(event);
    if (decoded.kind === "unknown") {
      const reason =
        decoded.reason === "version"
          ? `Version ${String(event.version)} ist neuer als dieser Code`
          : "Payload entspricht nicht dem Schema";
      this.skipped.push({ seq: event.seq, type: event.type, reason });
      return;
    }
    const reason = this.checkDecoded(event.type, event.actor, decoded.payload, event.runId);
    if (reason !== null) {
      this.skipped.push({ seq: event.seq, type: event.type, reason });
      return;
    }
    this.applyDecoded(event, decoded.payload);
  }

  private checkDecoded(
    type: string,
    actor: string,
    payload: unknown,
    runId: string | null,
  ): string | null {
    switch (type) {
      case AGENT_HIRED.type:
        return this.checkHired(actor, (payload as { profile: AgentProfile }).profile);
      case AGENT_PROFILE_CHANGED.type:
        return this.checkProfileChanged(actor, (payload as { profile: AgentProfile }).profile);
      case TASK_CREATED.type:
        return this.checkTaskCreated(actor, payload as TaskCreated);
      case TASK_DELEGATED.type:
        return this.checkTaskDelegated(actor, payload as TaskDelegated);
      case TASK_STATUS_CHANGED.type:
        return this.checkStatusChanged(actor, payload as TaskStatusChanged);
      case MESSAGE_SENT.type:
        return this.checkMessage(actor, payload as MessageSent);
      case TASK_HANDOVER.type:
        return this.checkHandover(actor, payload as TaskHandover, runId);
      case RUN_THOUGHT.type:
        return this.checkRunEvent(actor, runId);
      case RUN_FINISHED.type:
        return this.checkRunFinished(actor, payload as RunFinished, runId);
      default:
        return `${type} ist kein Ereignistyp des Domänenmodells`;
    }
  }

  private applyDecoded(event: StoredEvent, payload: unknown): void {
    switch (event.type) {
      case AGENT_HIRED.type:
      case AGENT_PROFILE_CHANGED.type: {
        const { profile } = payload as { profile: AgentProfile };
        const versions = this.profiles.get(profile.id) ?? [];
        versions.push(profile);
        this.profiles.set(profile.id, versions);
        return;
      }
      case TASK_CREATED.type: {
        const p = payload as TaskCreated;
        this.taskById.set(event.id, {
          id: event.id,
          title: p.title,
          description: p.description,
          runType: p.runType,
          repo: p.repo,
          createdBy: event.actor,
          assigneeId: p.assigneeId,
          parentTaskId: p.parentTaskId,
          status: "offen",
          reopenCount: 0,
          handover: null,
          createdSeq: event.seq,
          updatedSeq: event.seq,
        });
        return;
      }
      case TASK_DELEGATED.type: {
        const p = payload as TaskDelegated;
        const task = this.taskById.get(p.taskId) as Task;
        this.taskById.set(p.taskId, { ...task, assigneeId: p.assigneeId, updatedSeq: event.seq });
        return;
      }
      case TASK_STATUS_CHANGED.type: {
        const p = payload as TaskStatusChanged;
        const task = this.taskById.get(p.taskId) as Task;
        this.taskById.set(p.taskId, {
          ...task,
          status: p.status,
          reopenCount: task.reopenCount + (isReopen(task.status, p.status) ? 1 : 0),
          updatedSeq: event.seq,
        });
        return;
      }
      case MESSAGE_SENT.type: {
        const p = payload as MessageSent;
        const message: Message = {
          id: event.id,
          seq: event.seq,
          occurredAt: event.occurredAt,
          fromId: event.actor,
          toId: p.toId,
          kind: p.kind,
          text: p.text,
          taskId: p.taskId,
          replyToId: p.replyToId,
          runId: event.runId,
        };
        this.messageList.push(message);
        this.messageById.set(message.id, message);
        return;
      }
      case TASK_HANDOVER.type: {
        const p = payload as TaskHandover;
        const task = this.taskById.get(p.taskId) as Task;
        this.taskById.set(p.taskId, {
          ...task,
          handover: {
            note: p.note,
            auto: p.auto,
            writtenBy: event.actor,
            runId: event.runId,
            seq: event.seq,
          },
          updatedSeq: event.seq,
        });
        return;
      }
      case RUN_THOUGHT.type: {
        this.thoughtList.push({
          id: event.id,
          seq: event.seq,
          occurredAt: event.occurredAt,
          agentId: event.actor,
          runId: event.runId as string,
          text: (payload as RunThought).text,
        });
        return;
      }
      case RUN_FINISHED.type: {
        const p = payload as RunFinished;
        const runId = event.runId as string;
        this.runById.set(runId, {
          ...p,
          runId,
          agentId: event.actor,
          seq: event.seq,
          occurredAt: event.occurredAt,
        });
        if (p.exit === "completed" && p.inboxUpToSeq > this.inboxReadSeq(event.actor)) {
          this.inboxRead.set(event.actor, p.inboxUpToSeq);
        }
        return;
      }
    }
  }

  /** Arbeitsplatz und Ausstattung passen zum Gebäude (nur vor dem Schreiben). */
  private checkRoom(profile: AgentProfile): string | null {
    const room = findRoom(this.building, profile.roomId);
    if (room === undefined) {
      return `Raum ${profile.roomId} existiert nicht`;
    }
    const missing = profile.equipment.filter((item) => !room.equipment.includes(item));
    if (missing.length > 0) {
      return `Raum ${room.id} hat keine Ausstattung ${missing.join(", ")}`;
    }
    return null;
  }

  /** Gemeinsame Regeln für neue und geänderte Profile. */
  private checkPlacement(profile: AgentProfile): string | null {
    if (!this.isParticipant(profile.supervisorId)) {
      return `Vorgesetzter ${profile.supervisorId} existiert nicht`;
    }
    // Keine Ringe in der Berichtslinie: Die Kette der Vorgesetzten muss beim CEO enden.
    const seen = new Set([profile.id]);
    let current = profile.supervisorId;
    while (current !== CEO_ID) {
      if (seen.has(current)) {
        return "Berichtslinie bildet einen Ring";
      }
      seen.add(current);
      current = this.agent(current)?.supervisorId ?? CEO_ID;
    }
    return null;
  }

  private checkHired(actor: string, profile: AgentProfile): string | null {
    if (actor !== "system" && !this.isParticipant(actor)) {
      return `Handelnder ${actor} ist unbekannt`;
    }
    if (this.profiles.has(profile.id)) {
      return `Agent ${profile.id} existiert bereits`;
    }
    if (profile.version !== 1) {
      return "Ein neues Profil beginnt mit Version 1";
    }
    return this.checkPlacement(profile);
  }

  private checkProfileChanged(actor: string, profile: AgentProfile): string | null {
    if (!this.isParticipant(actor)) {
      return `Handelnder ${actor} ist unbekannt`;
    }
    const current = this.agent(profile.id);
    if (current === undefined) {
      return `Agent ${profile.id} existiert nicht`;
    }
    if (profile.version !== current.version + 1) {
      return `Version ${String(current.version + 1)} erwartet, nicht ${String(profile.version)}`;
    }
    return this.checkPlacement(profile);
  }

  private checkAssignee(assigneeId: string, runType: RunType): string | null {
    const assignee = this.agent(assigneeId);
    if (assignee === undefined) {
      return `Bearbeiter ${assigneeId} ist kein Agent`;
    }
    if (!allowedRunTypes(assignee.equipment).includes(runType)) {
      return `Agent ${assigneeId} hat keine Ausstattung für den Lauftyp ${runType}`;
    }
    return null;
  }

  private checkTaskCreated(actor: string, p: TaskCreated): string | null {
    if (!this.isParticipant(actor)) {
      return `Handelnder ${actor} ist unbekannt`;
    }
    if (p.parentTaskId !== null && !this.taskById.has(p.parentTaskId)) {
      return `Übergeordnete Aufgabe ${p.parentTaskId} existiert nicht`;
    }
    return p.assigneeId === null ? null : this.checkAssignee(p.assigneeId, p.runType);
  }

  private checkTaskDelegated(actor: string, p: TaskDelegated): string | null {
    if (!this.isParticipant(actor)) {
      return `Handelnder ${actor} ist unbekannt`;
    }
    const task = this.taskById.get(p.taskId);
    if (task === undefined) {
      return `Aufgabe ${p.taskId} existiert nicht`;
    }
    if (CLOSED_STATUSES.includes(task.status)) {
      return `Aufgabe ${p.taskId} ist abgeschlossen`;
    }
    if (task.assigneeId === p.assigneeId) {
      return `Aufgabe ${p.taskId} liegt bereits bei ${p.assigneeId}`;
    }
    return this.checkAssignee(p.assigneeId, task.runType);
  }

  private checkStatusChanged(actor: string, p: TaskStatusChanged): string | null {
    if (!this.isParticipant(actor)) {
      return `Handelnder ${actor} ist unbekannt`;
    }
    const task = this.taskById.get(p.taskId);
    if (task === undefined) {
      return `Aufgabe ${p.taskId} existiert nicht`;
    }
    if (!canTransition(task.status, p.status)) {
      return `Wechsel von ${task.status} nach ${p.status} ist nicht erlaubt`;
    }
    return null;
  }

  /** Gemeinsame Regeln für Ereignisse eines Laufs: Lauf-ID gesetzt, Lauf noch offen. */
  private checkRun(runId: string | null): string | null {
    if (runId === null) {
      return "Ereignis gehört zu keinem Lauf";
    }
    if (this.runById.has(runId)) {
      return `Lauf ${runId} ist bereits abgeschlossen`;
    }
    return null;
  }

  private checkRunEvent(actor: string, runId: string | null): string | null {
    if (this.agent(actor) === undefined) {
      return `Handelnder ${actor} ist kein Agent`;
    }
    return this.checkRun(runId);
  }

  /**
   * Eine Übergabenotiz schreibt der Bearbeiter der Aufgabe in seinem Lauf (`handover`) oder die
   * Auswertung als `system`, wenn der Lauf keine geschrieben hat (Kap. 5.2).
   */
  private checkHandover(actor: string, p: TaskHandover, runId: string | null): string | null {
    const task = this.taskById.get(p.taskId);
    if (task === undefined) {
      return `Aufgabe ${p.taskId} existiert nicht`;
    }
    if (p.auto ? actor !== "system" : actor !== task.assigneeId) {
      return p.auto
        ? "Eine automatische Übergabenotiz schreibt nur das System"
        : `Nur der Bearbeiter von ${p.taskId} schreibt die Übergabenotiz`;
    }
    return this.checkRun(runId);
  }

  private checkRunFinished(actor: string, p: RunFinished, runId: string | null): string | null {
    const reason = this.checkRunEvent(actor, runId);
    if (reason !== null) {
      return reason;
    }
    if (p.taskId !== null && !this.taskById.has(p.taskId)) {
      return `Aufgabe ${p.taskId} existiert nicht`;
    }
    if (p.inboxUpToSeq > this.lastSeq) {
      return `Postfach bis ${String(p.inboxUpToSeq)} liegt hinter dem Protokoll`;
    }
    return null;
  }

  private checkMessage(actor: string, p: MessageSent): string | null {
    if (!this.isParticipant(actor)) {
      return `Absender ${actor} ist unbekannt`;
    }
    if (!this.isParticipant(p.toId)) {
      return `Empfänger ${p.toId} ist unbekannt`;
    }
    if (p.toId === actor) {
      return "Absender und Empfänger sind gleich";
    }
    if (p.taskId !== null && !this.taskById.has(p.taskId)) {
      return `Aufgabe ${p.taskId} existiert nicht`;
    }
    if (p.replyToId !== null && !this.messageById.has(p.replyToId)) {
      return `Nachricht ${p.replyToId} existiert nicht`;
    }
    return null;
  }
}
