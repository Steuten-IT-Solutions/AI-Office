import { CEO_ID, allowedRunTypes, type AgentProfile } from "../domain/agent.ts";
import type { RunContext } from "../domain/context.ts";
import { MAX_RUN_TRIGGERS } from "../domain/events.ts";
import type { Office } from "../domain/office.ts";
import type { OfficeState, RunStart, WakeItem } from "../domain/office-state.ts";
import type { RunInfo } from "../domain/run-evaluation.ts";
import { CLOSED_STATUSES, type Task } from "../domain/task.ts";
import type { IpcParams, IpcResult } from "../ipc/protocol.ts";

/**
 * Planer (P06, plan.md Kap. 3.2, 3.3 Nr. 2 und 3, 5.4, E32, E36): deterministischer Code, kein
 * Agent. Er entscheidet, wer wann einen Lauf bekommt, und beantragt ihn beim Supervisor.
 *
 * Weckregeln (E32):
 * - `info` weckt niemanden. `auftrag` und `frage` wecken den Empfänger, eine Eskalation auch.
 *   Die Zuweisung einer Aufgabe (`create_task` mit Bearbeiter, `delegate`) weckt den Bearbeiter.
 * - Bündelung: Ein Agent wird höchstens alle `bundleMinutes` geweckt und liest dann alle neuen
 *   Nachrichten auf einmal. Ein Agent mit laufendem Lauf wird nicht geweckt.
 * - Weckbudget je Agent und Kalendertag (UTC) wie im Supervisor (S03). Hier nur Komfort: Ist es
 *   erschöpft, beantragt der Planer nichts mehr und informiert einmal am Tag den Vorgesetzten.
 * - Zyklenerkennung im ganzen Nachrichtengraphen über die Ursachenkette: Eine Nachricht aus
 *   einem Lauf hat als Ursache die Auslöser dieses Laufs. Kommt dieselbe Kante (Absender →
 *   Empfänger) in einer Kette öfter vor, als Kap. 4.3 zulässt, weckt die Nachricht niemanden,
 *   und der CEO bekommt einen Hinweis. Eine Nachricht des CEO beginnt eine neue Kette.
 *
 * Stillstand und PR-Obergrenze (E36):
 * - Eine offene Aufgabe ohne Fortschritt seit `stallHours` meldet der Planer dem CEO, einmal je
 *   Stand der Aufgabe.
 * - Ab `maxOpenPullRequests` offenen, nicht freigegebenen PRs in einem Repo startet der Planer
 *   dort keine neuen Code-Aufgaben (Kap. 5.14). Die Zahl liefert `openPullRequests`; solange es
 *   keine Quelle gibt (S08/S09), greift die Grenze nicht.
 *
 * Eskalationen ohne Antwort gibt der Planer nach `escalationTimeoutHours` eine Ebene höher
 * (Kap. 5.4, E47).
 *
 * Hinweise des Planers sind Nachrichten der Art `info` vom `system`. Jeder hat einen festen
 * Idempotenzschlüssel; so entsteht derselbe Hinweis auch nach einem Neustart nur einmal.
 *
 * Maßgeblich sind Weckbudget, Notaus, Statik und Rechte im Supervisor (Kap. 4.6). Der Planer
 * vermeidet nur Anträge, die ohnehin scheitern oder Kontingent ohne Nutzen verbrauchen.
 */

export interface PlannerConfig {
  /** Bündelung: Mindestabstand zweier Läufe eines Agenten (Kap. 5.4). [Annahme: 15] */
  bundleMinutes: number;
  /** Läufe je Agent und Kalendertag (UTC). Gleich wie `wakeBudgetPerDay` im Supervisor (S03). */
  wakeBudgetPerDay: number;
  /**
   * Wie oft sich ein Zyklus wiederholen darf (Kap. 4.3: „mehr als 5-mal“ löst aus). Eine Kante,
   * die in einer Ursachenkette zum `maxCycleRepeats + 2`-ten Mal vorkäme, weckt nicht.
   */
  maxCycleRepeats: number;
  /** Offene Aufgabe ohne Fortschritt gilt nach dieser Zeit als Stillstand (E36). [Annahme: 24] */
  stallHours: number;
  /** Eskalation ohne Antwort geht nach dieser Zeit eine Ebene höher (Kap. 5.4). [Annahme: 24] */
  escalationTimeoutHours: number;
  /** Obergrenze offener, nicht freigegebener PRs je Repo (E36). [Annahme: 3] */
  maxOpenPullRequests: number;
  /**
   * Ein Lauf ohne `run.finished` gilt nach dieser Zeit als verloren, der Agent ist wieder frei.
   * Die harte Lease im Container (E42) kommt mit P12/S05. [Annahme: 120]
   */
  staleRunMinutes: number;
  /** Wartezeit nach Ablehnung oder Fehler beim Antrag. [Annahme: 5] */
  retryMinutes: number;
}

export const DEFAULT_PLANNER_CONFIG: Readonly<PlannerConfig> = Object.freeze({
  bundleMinutes: 15,
  wakeBudgetPerDay: 20,
  maxCycleRepeats: 5,
  stallHours: 24,
  escalationTimeoutHours: 24,
  maxOpenPullRequests: 3,
  staleRunMinutes: 120,
  retryMinutes: 5,
});

/** Ein Lauf, den der Planer jetzt beantragen will. */
export interface Wake {
  agentId: string;
  taskId: string | null;
  /** Auslöser, älteste zuerst; höchstens `MAX_RUN_TRIGGERS`. */
  triggerIds: string[];
}

/** Ein Agent mit Auslösern, der erst später geweckt werden darf. */
export interface Hold {
  agentId: string;
  reason: "laeuft" | "buendelung" | "wiederholung" | "weckbudget";
  /** Ab wann er wieder geweckt werden darf. */
  until: Date;
}

/** Hinweis des Planers: Nachricht der Art `info` vom `system`. */
export interface Notice {
  key: string;
  toId: string;
  text: string;
  taskId: string | null;
}

export interface Plan {
  wakes: Wake[];
  holds: Hold[];
  notices: Notice[];
  /** Unbeantwortete Eskalationen, die jetzt eine Ebene höher gehen. */
  forwards: { escalationId: string; key: string }[];
  /** Auslöser, die wegen eines Zyklus niemanden wecken. */
  blocked: string[];
  /**
   * Frühester Zeitpunkt, an dem sich der Plan allein durch die Zeit ändert. Danach lohnt der
   * nächste Durchlauf; neue Ereignisse ändern ihn ohnehin.
   */
  nextCheckAt: Date | null;
}

export interface PlanInput {
  state: OfficeState;
  now: Date;
  config?: Partial<PlannerConfig>;
  /** Offene, nicht freigegebene PRs je Repo; `null`, wenn unbekannt. */
  openPullRequests?: (repo: string) => number | null;
  /** Je Agent: frühester Zeitpunkt für den nächsten Antrag nach Ablehnung oder Fehler. */
  retryAt?: ReadonlyMap<string, Date>;
  /** Zwischenspeicher der Ursachenketten. Ereignisse ändern sich nicht, er bleibt gültig. */
  chains?: CausalChains;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Kalendertag in UTC, wie im Supervisor (S03). */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfNextUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0),
  );
}

function at(iso: string): number {
  return new Date(iso).getTime();
}

function edgeOf(item: WakeItem): string {
  return `${item.fromId} → ${item.toId}`;
}

/**
 * Ursachenketten im Nachrichtengraphen. Für jede Nachricht, Eskalation und Zuweisung zählt sie je
 * Kante, wie oft die Kante höchstens auf einem einzelnen Weg zu ihr vorkommt. Der Weg führt über
 * den Lauf, in dem das Ereignis entstand, zu dessen Auslösern. Ohne Lauf (CEO, System) endet er.
 */
export class CausalChains {
  private readonly cache = new Map<string, ReadonlyMap<string, number>>();

  /** Kantenzähler der Kette, die bei `itemId` endet, einschließlich dessen eigener Kante. */
  edges(state: OfficeState, itemId: string): ReadonlyMap<string, number> {
    const cached = this.cache.get(itemId);
    if (cached !== undefined) {
      return cached;
    }
    // Ohne Rekursion, damit lange Ketten den Stack nicht sprengen.
    const stack: { id: string; expanded: boolean }[] = [{ id: itemId, expanded: false }];
    const onStack = new Set<string>();
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: string; expanded: boolean };
      if (this.cache.has(frame.id)) {
        stack.pop();
        continue;
      }
      const item = state.wakeItem(frame.id);
      if (item === undefined) {
        this.cache.set(frame.id, new Map());
        stack.pop();
        continue;
      }
      const parents = this.parents(state, item);
      if (!frame.expanded) {
        frame.expanded = true;
        onStack.add(frame.id);
        for (const parent of parents) {
          // Ein Auslöser liegt immer vor dem Lauf und damit vor dem Ereignis. Ein Ring wäre ein
          // Fehler in den Daten; er wird abgeschnitten statt endlos verfolgt.
          if (!this.cache.has(parent) && !onStack.has(parent)) {
            stack.push({ id: parent, expanded: false });
          }
        }
        continue;
      }
      const counts = new Map<string, number>();
      for (const parent of parents) {
        for (const [edge, count] of this.cache.get(parent) ?? new Map<string, number>()) {
          counts.set(edge, Math.max(counts.get(edge) ?? 0, count));
        }
      }
      const own = edgeOf(item);
      counts.set(own, (counts.get(own) ?? 0) + 1);
      this.cache.set(frame.id, counts);
      onStack.delete(frame.id);
      stack.pop();
    }
    return this.cache.get(itemId) as ReadonlyMap<string, number>;
  }

  private parents(state: OfficeState, item: WakeItem): string[] {
    if (item.runId === null) {
      return [];
    }
    const start = state.runStart(item.runId);
    if (start === undefined) {
      return [];
    }
    // Nur Auslöser, die vor dem Ereignis lagen. Die Prüfung von `run.started` stellt das sicher;
    // hier schützt es zusätzlich vor einem Ring.
    return start.triggerIds.filter((id) => (state.wakeItem(id)?.seq ?? Infinity) < item.seq);
  }
}

/** Ob der Agent gerade einen Lauf hat. Ein Lauf ohne Ende gilt nach `staleRunMinutes` als verloren. */
function activeRun(
  state: OfficeState,
  agentId: string,
  now: Date,
  config: PlannerConfig,
): RunStart | undefined {
  const limit = now.getTime() - config.staleRunMinutes * MINUTE_MS;
  return state
    .runStarts()
    .filter(
      (s) => s.agentId === agentId && state.run(s.runId) === undefined && at(s.occurredAt) > limit,
    )
    .at(-1);
}

function runsToday(state: OfficeState, agentId: string, now: Date): RunStart[] {
  const day = utcDay(now);
  return state
    .runStarts()
    .filter((s) => s.agentId === agentId && utcDay(new Date(s.occurredAt)) === day);
}

/**
 * Darf der Agent an der Aufgabe arbeiten? Abgeschlossene und blockierte Aufgaben nicht, Lauftypen
 * ohne Ausstattung nicht, und eine noch nie begonnene Code-Aufgabe nicht, solange ihr Repo die
 * PR-Obergrenze erreicht hat.
 */
function workable(
  state: OfficeState,
  agent: AgentProfile,
  task: Task,
  prLimited: ReadonlySet<string>,
): boolean {
  if (task.assigneeId !== agent.id || CLOSED_STATUSES.includes(task.status)) {
    return false;
  }
  if (!allowedRunTypes(agent.equipment).includes(task.runType)) {
    return false;
  }
  return !(task.repo !== null && prLimited.has(task.repo) && isNewCodeTask(state, task));
}

/** Code-Aufgabe, für die noch nie ein Lauf zugelassen wurde (E36: „neue Code-Aufgaben“). */
function isNewCodeTask(state: OfficeState, task: Task): boolean {
  return task.runType === "werkbank" && !state.runStarts().some((s) => s.taskId === task.id);
}

/**
 * Wartende Auslöser eines Agenten, älteste zuerst:
 * - Nachrichten `auftrag` und `frage` und unbeantwortete Eskalationen nach dem Postfach-Zeiger,
 * - Zuweisungen offener Aufgaben (nicht blockiert), nach denen noch kein Lauf des Agenten zu
 *   dieser Aufgabe vollständig (`completed`) endete. Endet ein Lauf mit Fehler, weckt die
 *   Zuweisung erneut (Kap. 5.14: „Aufgabe neu eingeplant“).
 */
function pendingItems(
  state: OfficeState,
  agent: AgentProfile,
  prLimited: ReadonlySet<string>,
): WakeItem[] {
  const readSeq = state.inboxReadSeq(agent.id);
  const items: WakeItem[] = [];
  for (const m of state.messages({ toId: agent.id, afterSeq: readSeq })) {
    if (m.kind !== "info") {
      items.push(state.wakeItem(m.id) as WakeItem);
    }
  }
  for (const e of state.escalations({ toId: agent.id, afterSeq: readSeq })) {
    if (e.answeredSeq === null) {
      items.push(state.wakeItem(e.id) as WakeItem);
    }
  }
  const runs = state.runs();
  for (const task of state.tasks()) {
    const assignment = task.assignment;
    if (
      assignment === null ||
      task.status === "blockiert" ||
      !workable(state, agent, task, prLimited)
    ) {
      continue;
    }
    // Maßgeblich ist, wann der Lauf begann: Ein Lauf, der vor einer erneuten Zuweisung begann,
    // kennt sie nicht, auch wenn er erst danach endet.
    const done = runs.some(
      (r) =>
        r.agentId === agent.id &&
        r.taskId === task.id &&
        r.exit === "completed" &&
        (state.runStart(r.runId)?.seq ?? r.seq) > assignment.seq,
    );
    if (!done) {
      items.push(state.wakeItem(assignment.eventId) as WakeItem);
    }
  }
  return items.sort((a, b) => a.seq - b.seq);
}

/**
 * Aufgabe des Laufs: die älteste zugewiesene, sonst die Aufgabe der jüngsten Nachricht, wenn sie
 * beim Agenten liegt (z. B. Antwort zu einer blockierten Aufgabe), sonst keine (`buero`). Eine
 * `recherche`-Aufgabe nur über ihre Zuweisung: Ein solcher Lauf liest das Postfach nicht (P07),
 * die Nachricht weckte sonst immer wieder denselben Lauf.
 */
function chooseTask(
  state: OfficeState,
  agent: AgentProfile,
  items: readonly WakeItem[],
  prLimited: ReadonlySet<string>,
): string | null {
  const assignment = items.find((i) => i.kind === "assignment");
  if (assignment !== undefined) {
    return assignment.taskId;
  }
  for (const item of [...items].reverse()) {
    const task = item.taskId === null ? undefined : state.task(item.taskId);
    if (
      task !== undefined &&
      task.runType !== "recherche" &&
      workable(state, agent, task, prLimited)
    ) {
      return task.id;
    }
  }
  return null;
}

function earliest(a: Date | null, b: Date): Date {
  return a === null || b < a ? b : a;
}

/** Berechnet den Plan aus dem Zustand. Schreibt nichts und ruft niemanden auf. */
export function plan(input: PlanInput): Plan {
  const { state, now } = input;
  const config: PlannerConfig = { ...DEFAULT_PLANNER_CONFIG, ...input.config };
  const chains = input.chains ?? new CausalChains();
  const result: Plan = {
    wakes: [],
    holds: [],
    notices: [],
    forwards: [],
    blocked: [],
    nextCheckAt: null,
  };
  const day = utcDay(now);

  // PR-Obergrenze je Repo (E36).
  const prLimited = new Set<string>();
  const repos = new Set(
    state
      .tasks()
      .filter((t) => isNewCodeTask(state, t) && t.repo !== null)
      .map((t) => t.repo as string),
  );
  for (const repo of [...repos].sort()) {
    const open = input.openPullRequests?.(repo) ?? null;
    if (open !== null && open >= config.maxOpenPullRequests) {
      prLimited.add(repo);
      result.notices.push({
        key: `planner:pr-obergrenze:${repo}:${day}`,
        toId: CEO_ID,
        taskId: null,
        text: `PR-Obergrenze erreicht: ${repo} hat ${String(open)} offene, nicht freigegebene PRs (Grenze ${String(config.maxOpenPullRequests)}). Neue Code-Aufgaben in diesem Repo warten, bis PRs freigegeben oder geschlossen sind (E36).`,
      });
    }
  }

  const agents = state.agents().sort((a, b) => a.id.localeCompare(b.id));
  for (const agent of agents) {
    const items: WakeItem[] = [];
    for (const item of pendingItems(state, agent, prLimited)) {
      const count = chains.edges(state, item.id).get(edgeOf(item)) ?? 0;
      if (count - 1 > config.maxCycleRepeats) {
        result.blocked.push(item.id);
        result.notices.push({
          key: `planner:zyklus:${item.id}`,
          toId: CEO_ID,
          taskId: item.taskId,
          text: `Zyklus erkannt: Die Kante ${edgeOf(item)} kommt in einer Ursachenkette zum ${String(count)}. Mal vor (Grenze: ${String(config.maxCycleRepeats)} Wiederholungen, Kap. 4.3). Das Ereignis ${item.id} weckt deshalb niemanden. Eine neue Nachricht des CEO beginnt eine neue Kette.`,
        });
        continue;
      }
      items.push(item);
    }
    if (items.length === 0) {
      continue;
    }

    const running = activeRun(state, agent.id, now, config);
    if (running !== undefined) {
      const until = new Date(at(running.occurredAt) + config.staleRunMinutes * MINUTE_MS);
      result.holds.push({ agentId: agent.id, reason: "laeuft", until });
      result.nextCheckAt = earliest(result.nextCheckAt, until);
      continue;
    }

    const today = runsToday(state, agent.id, now);
    if (today.length >= config.wakeBudgetPerDay) {
      const until = startOfNextUtcDay(now);
      result.holds.push({ agentId: agent.id, reason: "weckbudget", until });
      result.nextCheckAt = earliest(result.nextCheckAt, until);
      result.notices.push({
        key: `planner:weckbudget:${agent.id}:${day}`,
        toId: agent.supervisorId,
        taskId: null,
        text: `Weckbudget erschöpft: ${agent.name} (${agent.id}) hatte heute (${day}, UTC) ${String(today.length)} Läufe, das Budget ist ${String(config.wakeBudgetPerDay)}. Neue Nachrichten warten bis morgen (E32).`,
      });
      continue;
    }

    const last = state
      .runStarts()
      .filter((s) => s.agentId === agent.id)
      .at(-1);
    if (last !== undefined) {
      const until = new Date(at(last.occurredAt) + config.bundleMinutes * MINUTE_MS);
      if (until > now) {
        result.holds.push({ agentId: agent.id, reason: "buendelung", until });
        result.nextCheckAt = earliest(result.nextCheckAt, until);
        continue;
      }
    }

    const retry = input.retryAt?.get(agent.id);
    if (retry !== undefined && retry > now) {
      result.holds.push({ agentId: agent.id, reason: "wiederholung", until: retry });
      result.nextCheckAt = earliest(result.nextCheckAt, retry);
      continue;
    }

    result.wakes.push({
      agentId: agent.id,
      taskId: chooseTask(state, agent, items, prLimited),
      triggerIds: items.slice(0, MAX_RUN_TRIGGERS).map((i) => i.id),
    });
  }

  // Eskalationen ohne Antwort eine Ebene höher (Kap. 5.4).
  for (const e of state.escalations()) {
    if (e.answeredSeq !== null || e.toId === CEO_ID) {
      continue;
    }
    const due = new Date(at(e.occurredAt) + config.escalationTimeoutHours * HOUR_MS);
    if (due <= now) {
      result.forwards.push({ escalationId: e.id, key: `planner:eskalation:${e.id}` });
    } else {
      result.nextCheckAt = earliest(result.nextCheckAt, due);
    }
  }

  // Stillstand: offene Aufgaben ohne Fortschritt (E36).
  for (const task of state.tasks()) {
    if (CLOSED_STATUSES.includes(task.status)) {
      continue;
    }
    const lastRun = state
      .runStarts()
      .filter((s) => s.taskId === task.id)
      .at(-1);
    const progress = Math.max(
      at(task.updatedAt),
      lastRun === undefined ? 0 : at(lastRun.occurredAt),
    );
    const due = new Date(progress + config.stallHours * HOUR_MS);
    if (due <= now) {
      result.notices.push({
        key: `planner:stillstand:${task.id}:${String(task.updatedSeq)}`,
        toId: CEO_ID,
        taskId: task.id,
        text: `Stillstand: Die Aufgabe „${task.title}“ (${task.id}, Status ${task.status}, bei ${task.assigneeId ?? "niemandem"}) hat seit ${String(config.stallHours)} h keinen Fortschritt (E36).`,
      });
    } else {
      result.nextCheckAt = earliest(result.nextCheckAt, due);
    }
  }
  return result;
}

/** `RunInfo` für die Auswertung (P07) aus dem Start eines Laufs. */
export function runInfo(start: RunStart): RunInfo {
  return {
    runId: start.runId,
    agentId: start.agentId,
    taskId: start.taskId,
    runType: start.runType,
    model: start.model,
    inboxUpToSeq: start.inboxUpToSeq,
  };
}

/** Antrag beim Supervisor (`run.request`, Kap. 4.6). */
export interface RunRequester {
  requestRun(params: IpcParams<"run.request">): Promise<IpcResult<"run.request">>;
}

export interface PlannerOptions {
  office: Office;
  requester: RunRequester;
  /** Baut den Kontext eines Laufs, in der Regel mit `buildContext` (P07). */
  context: (state: OfficeState, agentId: string, taskId: string | null) => RunContext;
  config?: Partial<PlannerConfig>;
  openPullRequests?: (repo: string) => number | null;
}

/** Ergebnis eines Durchlaufs. */
export interface TickResult {
  started: RunStart[];
  rejected: { agentId: string; reason: string }[];
  /**
   * Antrag oder Festhalten gescheitert. Bei `outcomeUnknown` kann der Supervisor den Lauf
   * zugelassen haben, ohne dass das Office davon weiß; der Abgleich kommt mit S05 (E42).
   */
  failed: { agentId: string; error: string; outcomeUnknown: boolean }[];
  notices: number;
  forwards: number;
  /** Hinweise oder Weitergaben, die nicht geschrieben werden konnten. */
  errors: string[];
  plan: Plan;
}

/**
 * Führt den Plan aus: Hinweise schreiben, Eskalationen weitergeben, Läufe beantragen und
 * zugelassene Läufe festhalten. Durchläufe laufen nacheinander, nie gleichzeitig: Zwei
 * gleichzeitige Durchläufe könnten für denselben Agenten zwei Läufe beantragen.
 */
export class Planner {
  private readonly office: Office;
  private readonly requester: RunRequester;
  private readonly context: PlannerOptions["context"];
  private readonly config: PlannerConfig;
  private readonly openPullRequests: PlannerOptions["openPullRequests"];
  private readonly chains = new CausalChains();
  private readonly retryAt = new Map<string, Date>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: PlannerOptions) {
    this.office = options.office;
    this.requester = options.requester;
    this.context = options.context;
    this.config = { ...DEFAULT_PLANNER_CONFIG, ...options.config };
    this.openPullRequests = options.openPullRequests;
  }

  /** Ein Durchlauf. Wartet, bis ein laufender Durchlauf fertig ist. */
  tick(): Promise<TickResult> {
    const next = this.queue.then(() => this.run());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run(): Promise<TickResult> {
    const office = this.office;
    office.sync();
    const now = office.now();
    const current = plan({
      state: office.state,
      now,
      config: this.config,
      ...(this.openPullRequests === undefined ? {} : { openPullRequests: this.openPullRequests }),
      retryAt: this.retryAt,
      chains: this.chains,
    });
    const result: TickResult = {
      started: [],
      rejected: [],
      failed: [],
      notices: 0,
      forwards: 0,
      errors: [],
      plan: current,
    };

    // Ein Hinweis, der scheitert, darf die Läufe der anderen nicht aufhalten.
    for (const notice of current.notices) {
      if (office.hasCommitted(notice.key)) {
        continue;
      }
      try {
        office.sendMessage(
          "system",
          { toId: notice.toId, kind: "info", text: notice.text, taskId: notice.taskId },
          { idempotencyKey: notice.key },
        );
        result.notices += 1;
      } catch (error) {
        result.errors.push(`${notice.key}: ${message(error)}`);
      }
    }
    for (const forward of current.forwards) {
      if (office.hasCommitted(forward.key)) {
        continue;
      }
      try {
        office.forwardEscalation(forward.escalationId, this.config.escalationTimeoutHours, {
          idempotencyKey: forward.key,
        });
        result.forwards += 1;
      } catch (error) {
        result.errors.push(`${forward.key}: ${message(error)}`);
      }
    }

    for (const wake of current.wakes) {
      await this.wake(wake, result);
    }
    return result;
  }

  private async wake(wake: Wake, result: TickResult): Promise<void> {
    const office = this.office;
    const agent = office.state.agent(wake.agentId) as AgentProfile;
    const retryLater = () => {
      this.retryAt.set(
        wake.agentId,
        new Date(office.now().getTime() + this.config.retryMinutes * MINUTE_MS),
      );
    };
    let context: RunContext;
    try {
      context = this.context(office.state, wake.agentId, wake.taskId);
    } catch (error) {
      retryLater();
      result.failed.push({ agentId: wake.agentId, error: message(error), outcomeUnknown: false });
      return;
    }
    const task = wake.taskId === null ? undefined : office.state.task(wake.taskId);
    let answer: IpcResult<"run.request">;
    try {
      answer = await this.requester.requestRun({
        agentId: wake.agentId,
        runType: context.runType,
        taskId: wake.taskId,
        repo: context.runType === "werkbank" ? (task?.repo ?? null) : null,
        model: agent.models.default,
        prompt: context.prompt,
      });
    } catch (error) {
      retryLater();
      result.failed.push({
        agentId: wake.agentId,
        error: message(error),
        outcomeUnknown: outcomeUnknown(error),
      });
      return;
    }
    if (answer.decision === "rejected") {
      retryLater();
      result.rejected.push({ agentId: wake.agentId, reason: answer.reason });
      return;
    }
    this.retryAt.delete(wake.agentId);
    try {
      result.started.push(
        office.recordRunStarted(
          {
            agentId: wake.agentId,
            taskId: wake.taskId,
            runType: context.runType,
            model: agent.models.default,
            inboxUpToSeq: context.inboxUpToSeq,
            triggerIds: wake.triggerIds,
          },
          { runId: answer.runId, idempotencyKey: `${answer.runId}:started` },
        ),
      );
    } catch (error) {
      // Zugelassen, aber nicht festgehalten, etwa weil die Aufgabe inzwischen woanders liegt.
      retryLater();
      result.failed.push({ agentId: wake.agentId, error: message(error), outcomeUnknown: true });
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outcomeUnknown(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "outcomeUnknown" in error &&
    error.outcomeUnknown === true
  );
}
