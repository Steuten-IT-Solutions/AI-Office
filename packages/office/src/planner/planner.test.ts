import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore } from "../events/event-store.ts";
import { buildContext } from "../domain/context.ts";
import { DomainError, Office } from "../domain/office.ts";
import { RunEvaluation } from "../domain/run-evaluation.ts";
import { loadStartBooks, loadStartPersonas } from "../domain/start-content.ts";
import { loadStartData, seedStartAgents, type StartData } from "../domain/start-data.ts";
import { IpcCallError, IpcTransportError, supervisorRunRequester } from "../ipc/client.ts";
import type { SupervisorClient } from "../ipc/client.ts";
import type { IpcParams, IpcResult } from "../ipc/protocol.ts";
import type { RunOutcome } from "../llm/runner.ts";
import {
  CausalChains,
  DEFAULT_PLANNER_CONFIG,
  Planner,
  plan,
  runInfo,
  utcDay,
  type PlannerConfig,
  type RunRequester,
  type TickResult,
} from "./planner.ts";

const CTO = "jonas-albrecht";
const CFO = "ingrid-wolters";
const COO = "deniz-kaya";
const CHRO = "amara-okafor";
const REPO = "Steuten-IT-Solutions/AI-Office";
const CONSTITUTION = "# Verfassung\n\n1. Der CEO ist oberste Instanz.";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const books = loadStartBooks();
const personas = loadStartPersonas();

let dir: string;
let start: StartData;
let store: EventStore;
let office: Office;
let clock: Date;

/** Supervisor-Attrappe: lässt zu, lehnt ab oder wirft, je nach `answer`. */
class FakeSupervisor implements RunRequester {
  readonly requests: IpcParams<"run.request">[] = [];
  answer: (params: IpcParams<"run.request">) => Promise<IpcResult<"run.request">> = () =>
    Promise.resolve({ decision: "admitted", runId: `run-${String(this.requests.length)}` });

  requestRun(params: IpcParams<"run.request">): Promise<IpcResult<"run.request">> {
    this.requests.push(params);
    return this.answer(params);
  }
}

let supervisor: FakeSupervisor;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-planner-"));
  start = loadStartData();
  store = EventStore.open(join(dir, "office.db"));
  clock = new Date("2026-11-05T08:00:00.000Z");
  office = Office.open(store, start.building, { now: () => clock });
  seedStartAgents(office, start.agents);
  supervisor = new FakeSupervisor();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

function planner(config: Partial<PlannerConfig> = {}, extra: { prs?: number | null } = {}) {
  return new Planner({
    office,
    requester: supervisor,
    context: (state, agentId, taskId) =>
      buildContext({
        state,
        agentId,
        taskId,
        constitution: CONSTITUTION,
        directives: [],
        books,
        personas,
      }),
    config,
    ...(extra.prs === undefined ? {} : { openPullRequests: () => extra.prs ?? null }),
  });
}

function send(fromId: string, toId: string, kind: "auftrag" | "frage" | "info", runId?: string) {
  return office.sendMessage(
    fromId,
    { toId, kind, text: `${kind} von ${fromId} an ${toId}` },
    runId === undefined ? {} : { runId },
  );
}

function outcome(runId: string, exit: RunOutcome["exit"] = "completed"): RunOutcome {
  return {
    runId,
    exit,
    resultSubtype: exit === "completed" ? "success" : "error_during_execution",
    finalText: "Erledigt.",
    totalCostUsd: 0.01,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    modelUsage: {},
    numTurns: 1,
    rateLimitStatus: null,
    invalidLines: 0,
  };
}

/** Beendet einen Lauf so, wie es später die Auswertung (P07) tut. */
function finish(result: TickResult, index = 0, exit: RunOutcome["exit"] = "completed") {
  const started = result.started[index];
  if (started === undefined) {
    throw new Error("kein Lauf gestartet");
  }
  return new RunEvaluation(office, runInfo(started)).finish(outcome(started.runId, exit));
}

describe("Weckregeln (E32)", () => {
  it("info weckt niemanden, auftrag und frage wecken den Empfänger", async () => {
    const p = planner();
    send("ceo", COO, "info");
    expect((await p.tick()).started).toEqual([]);
    expect(supervisor.requests).toEqual([]);

    const order = send("ceo", COO, "auftrag");
    const question = send("ceo", CFO, "frage");
    const result = await p.tick();
    expect(result.started.map((s) => [s.agentId, s.taskId, s.runType, s.model])).toEqual([
      [COO, null, "buero", "sonnet"],
      [CFO, null, "buero", "sonnet"],
    ]);
    expect(result.started[0]?.triggerIds).toEqual([order.id]);
    expect(result.started[1]?.triggerIds).toEqual([question.id]);
    const request = supervisor.requests[0] as IpcParams<"run.request">;
    expect(request).toMatchObject({ agentId: COO, runType: "buero", taskId: null, repo: null });
    // Die Info liest der Lauf mit, auch wenn sie ihn nicht ausgelöst hat.
    expect(request.prompt).toContain("info von ceo an deniz-kaya");
    expect(request.prompt).toContain("auftrag von ceo an deniz-kaya");
    expect(result.started[0]?.inboxUpToSeq).toBe(question.seq);
  });

  it("weckt einen Agenten mit laufendem Lauf nicht und gibt ihn nach staleRunMinutes frei", async () => {
    const p = planner();
    send("ceo", COO, "auftrag");
    await p.tick();
    advance(20 * MINUTE);
    send("ceo", COO, "frage");
    const busy = await p.tick();
    expect(busy.started).toEqual([]);
    expect(busy.plan.holds).toEqual([
      { agentId: COO, reason: "laeuft", until: new Date("2026-11-05T10:00:00.000Z") },
    ]);
    expect(busy.plan.nextCheckAt).toEqual(new Date("2026-11-05T10:00:00.000Z"));
    advance(100 * MINUTE);
    expect((await p.tick()).started.map((s) => s.agentId)).toEqual([COO]);
  });

  it("bündelt: höchstens alle 15 Minuten, dann alle neuen Nachrichten auf einmal", async () => {
    const p = planner();
    send("ceo", COO, "auftrag");
    const first = await p.tick();
    finish(first);
    advance(5 * MINUTE);
    const a = send("ceo", COO, "auftrag");
    advance(4 * MINUTE);
    const b = send(CFO, COO, "frage");
    const held = await p.tick();
    expect(held.started).toEqual([]);
    expect(held.plan.holds).toEqual([
      { agentId: COO, reason: "buendelung", until: new Date("2026-11-05T08:15:00.000Z") },
    ]);
    advance(6 * MINUTE);
    const bundled = await p.tick();
    expect(bundled.started.map((s) => s.triggerIds)).toEqual([[a.id, b.id]]);
    expect(supervisor.requests).toHaveLength(2);
  });

  it("weckt nach einem vollständigen Lauf nicht erneut, nach einem Fehler schon", async () => {
    const p = planner({ bundleMinutes: 0 });
    send("ceo", COO, "auftrag");
    finish(await p.tick(), 0, "error");
    advance(MINUTE);
    const retry = await p.tick();
    expect(retry.started.map((s) => s.agentId)).toEqual([COO]);
    finish(retry);
    advance(MINUTE);
    expect((await p.tick()).started).toEqual([]);
  });

  it("weckt für unbeantwortete Eskalationen, nicht für beantwortete", async () => {
    const p = planner();
    const escalation = office.escalate(CFO, { text: "Budget unklar" });
    expect(escalation.toId).toBe(COO);
    const result = await p.tick();
    expect(result.started.map((s) => [s.agentId, s.triggerIds])).toEqual([[COO, [escalation.id]]]);
    expect(supervisor.requests[0]?.prompt).toContain("Budget unklar");
  });
});

describe("Aufgaben", () => {
  it("die Zuweisung weckt den Bearbeiter mit Lauftyp und Repo der Aufgabe", async () => {
    const p = planner();
    const task = office.createTask("ceo", {
      title: "Readme ergänzen",
      description: "Abschnitt Planer",
      runType: "werkbank",
      repo: REPO,
      assigneeId: CTO,
    });
    const result = await p.tick();
    expect(result.started.map((s) => [s.agentId, s.taskId, s.runType])).toEqual([
      [CTO, task.id, "werkbank"],
    ]);
    expect(result.started[0]?.triggerIds).toEqual([task.assignment?.eventId]);
    expect(supervisor.requests[0]).toMatchObject({ runType: "werkbank", repo: REPO });

    finish(result);
    advance(20 * MINUTE);
    expect((await p.tick()).started).toEqual([]);
  });

  it("weckt nach einer Delegation den neuen Bearbeiter, blockierte Aufgaben nicht", async () => {
    const p = planner();
    const task = office.createTask("ceo", {
      title: "Kosten prüfen",
      description: "Monatsbericht",
      runType: "buero",
      assigneeId: COO,
    });
    office.changeTaskStatus("ceo", task.id, "blockiert");
    expect((await p.tick()).started).toEqual([]);

    office.changeTaskStatus("ceo", task.id, "offen");
    const delegated = office.delegateTask(COO, task.id, CFO);
    const result = await p.tick();
    expect(result.started.map((s) => [s.agentId, s.taskId, s.triggerIds])).toEqual([
      [CFO, task.id, [delegated.assignment?.eventId]],
    ]);
  });

  it("ein Lauf, der vor einer erneuten Zuweisung begann, erledigt sie nicht", async () => {
    const p = planner({ bundleMinutes: 0 });
    const task = office.createTask("ceo", {
      title: "Plan prüfen",
      description: "…",
      runType: "buero",
      assigneeId: COO,
    });
    const first = await p.tick();
    office.delegateTask("ceo", task.id, CFO);
    const back = office.delegateTask("ceo", task.id, COO);
    finish(first);
    advance(MINUTE);
    const result = await p.tick();
    expect(result.started.map((s) => [s.agentId, s.triggerIds])).toEqual([
      [COO, [back.assignment?.eventId]],
    ]);
  });

  it("eine Antwort zu einer blockierten Aufgabe weckt mit dieser Aufgabe", async () => {
    const p = planner();
    const task = office.createTask("ceo", {
      title: "Lieferant wählen",
      description: "Angebote vergleichen",
      runType: "buero",
      assigneeId: COO,
    });
    finish(await p.tick());
    office.changeTaskStatus(COO, task.id, "blockiert");
    advance(20 * MINUTE);
    office.sendMessage("ceo", { toId: COO, kind: "auftrag", text: "Nimm B.", taskId: task.id });
    const result = await p.tick();
    expect(result.started.map((s) => [s.agentId, s.taskId])).toEqual([[COO, task.id]]);
  });

  it("wählt für eine Nachricht keine recherche-Aufgabe, denn die liest kein Postfach", async () => {
    const p = planner();
    const task = office.createTask("ceo", {
      title: "Markt sichten",
      description: "Wettbewerber",
      runType: "recherche",
      assigneeId: CFO,
    });
    const first = await p.tick();
    expect(first.started.map((s) => [s.taskId, s.runType])).toEqual([[task.id, "recherche"]]);
    finish(first);
    advance(20 * MINUTE);
    office.sendMessage("ceo", { toId: CFO, kind: "frage", text: "Stand?", taskId: task.id });
    const second = await p.tick();
    expect(second.started.map((s) => [s.taskId, s.runType])).toEqual([[null, "buero"]]);
  });
});

describe("Weckbudget (E32)", () => {
  it("hält den Agenten bis zum nächsten Tag an und informiert den Vorgesetzten einmal", async () => {
    const p = planner({ wakeBudgetPerDay: 2, bundleMinutes: 0 });
    for (let i = 0; i < 2; i += 1) {
      send("ceo", COO, "auftrag");
      finish(await p.tick());
      advance(MINUTE);
    }
    send("ceo", COO, "auftrag");
    const held = await p.tick();
    expect(held.started).toEqual([]);
    expect(held.plan.holds).toEqual([
      { agentId: COO, reason: "weckbudget", until: new Date("2026-11-06T00:00:00.000Z") },
    ]);
    expect(held.notices).toBe(1);
    const notice = office.state.messages({ toId: "ceo" }).at(-1);
    expect(notice).toMatchObject({ fromId: "system", kind: "info" });
    expect(notice?.text).toContain("Weckbudget erschöpft");
    expect((await p.tick()).notices).toBe(0);

    clock = new Date("2026-11-06T00:00:00.000Z");
    expect((await p.tick()).started.map((s) => s.agentId)).toEqual([COO]);
  });

  it("zählt nach dem Kalendertag in UTC wie der Supervisor", () => {
    expect(utcDay(new Date("2026-11-05T23:59:59.999Z"))).toBe("2026-11-05");
    expect(utcDay(new Date("2026-11-06T00:00:00.000Z"))).toBe("2026-11-06");
    expect(DEFAULT_PLANNER_CONFIG.wakeBudgetPerDay).toBe(20);
  });
});

describe("Zyklenerkennung", () => {
  /** Lässt den geweckten Agenten eine Nachricht an `toId` schicken und den Lauf beenden. */
  async function hop(p: Planner, toId: string) {
    const result = await p.tick();
    const started = result.started[0];
    if (started === undefined) {
      return { result, message: undefined };
    }
    const message = send(started.agentId, toId, "auftrag", started.runId);
    finish(result);
    advance(MINUTE);
    return { result, message };
  }

  it("erkennt A → B → C → A, wenn sich der Zyklus mehr als fünfmal wiederholt", async () => {
    const p = planner({ bundleMinutes: 0, wakeBudgetPerDay: 100 });
    const ring = [COO, CFO, CHRO];
    send("ceo", COO, "auftrag");
    const woken: string[] = [];
    let last;
    for (let i = 0; i < 30; i += 1) {
      const next = ring[(i + 1) % 3] as string;
      const step = await hop(p, next);
      if (step.message === undefined) {
        last = step.result;
        break;
      }
      woken.push(step.result.started[0]?.agentId as string);
    }
    // Jede Kante darf 6-mal vorkommen (1 + 5 Wiederholungen); die 7. weckt nicht. Geweckt haben
    // die Nachricht des CEO und 18 Nachrichten im Ring, die 19. (COO → CFO zum 7. Mal) nicht.
    expect(woken).toHaveLength(19);
    expect(last?.plan.blocked).toHaveLength(1);
    expect(last?.notices).toBe(1);
    const notice = office.state.messages({ toId: "ceo" }).at(-1);
    expect(notice?.fromId).toBe("system");
    expect(notice?.text).toContain(`Zyklus erkannt: Die Kante ${COO} → ${CFO}`);
    expect(notice?.text).toContain("zum 7. Mal");

    // Eine Nachricht des CEO beginnt eine neue Kette und weckt wieder.
    send("ceo", CFO, "auftrag");
    expect((await p.tick()).started.map((s) => s.agentId)).toEqual([CFO]);
  });

  it("erkennt auch Ping-Pong zwischen zwei Agenten", async () => {
    const p = planner({ bundleMinutes: 0, wakeBudgetPerDay: 100, maxCycleRepeats: 1 });
    send("ceo", COO, "frage");
    const steps = [CFO, COO, CFO, COO, CFO];
    const woken: string[] = [];
    for (const toId of steps) {
      const step = await hop(p, toId);
      woken.push(step.result.started[0]?.agentId as string);
    }
    // Mit einer erlaubten Wiederholung darf jede Kante zweimal vorkommen. Die letzte Nachricht ist
    // COO → CFO zum dritten Mal und weckt nicht.
    expect(woken).toEqual([COO, CFO, COO, CFO, COO]);
    expect((await p.tick()).plan.blocked).toHaveLength(1);
  });

  it("nimmt bei gebündelten Auslösern je Kante den längsten Weg", () => {
    const begin = (agentId: string, runId: string, triggerIds: string[]) =>
      office.recordRunStarted(
        {
          agentId,
          taskId: null,
          runType: "buero",
          model: "sonnet",
          inboxUpToSeq: 0,
          triggerIds,
        },
        { runId },
      );
    const m0 = send("ceo", COO, "auftrag");
    begin(COO, "r1", [m0.id]);
    const m1 = send(COO, CFO, "auftrag", "r1");
    begin(CFO, "r2", [m1.id]);
    const m2 = send(CFO, COO, "auftrag", "r2");
    begin(COO, "r3", [m2.id]);
    const m3 = send(COO, CFO, "auftrag", "r3");
    const m4 = send("ceo", COO, "auftrag");
    begin(COO, "r4", [m4.id]);
    const m5 = send(COO, CFO, "auftrag", "r4");
    // Ein Lauf mit beiden Auslösern: der lange Weg über m3, der kurze über m5.
    begin(CFO, "r5", [m3.id, m5.id]);
    const m6 = send(CFO, CHRO, "auftrag", "r5");

    const chains = new CausalChains();
    expect(Object.fromEntries(chains.edges(office.state, m6.id))).toEqual({
      [`ceo → ${COO}`]: 1,
      [`${COO} → ${CFO}`]: 2,
      [`${CFO} → ${COO}`]: 1,
      [`${CFO} → ${CHRO}`]: 1,
    });
    expect(chains.edges(office.state, m5.id).get(`${COO} → ${CFO}`)).toBe(1);
  });

  it("zählt eine Kette ohne Wiederholung nicht als Zyklus", async () => {
    const p = planner({ bundleMinutes: 0, maxCycleRepeats: 0 });
    send("ceo", COO, "auftrag");
    for (const toId of [CFO, CHRO, CTO]) {
      const step = await hop(p, toId);
      expect(step.message).toBeDefined();
    }
    const last = await p.tick();
    expect(last.plan.blocked).toEqual([]);
    expect(last.started.map((s) => s.agentId)).toEqual([CTO]);
  });
});

describe("Eskalation ohne Antwort", () => {
  it("geht nach dem Timeout eine Ebene höher, einmal", async () => {
    const p = planner();
    const escalation = office.escalate(CFO, { text: "Budget unklar" });
    finish(await p.tick());
    advance(24 * HOUR - MINUTE);
    expect((await p.tick()).forwards).toBe(0);
    advance(MINUTE);
    expect((await p.tick()).forwards).toBe(1);
    const forwarded = office.state.escalations({ toId: "ceo" });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.fromId).toBe("system");
    expect(forwarded[0]?.text).toContain(`Weitergeleitet: Eskalation ${escalation.id}`);
    expect(forwarded[0]?.text).toContain("Budget unklar");
    expect((await p.tick()).forwards).toBe(0);
  });

  it("beantwortete Eskalationen bleiben, wo sie sind", async () => {
    const p = planner();
    const escalation = office.escalate(CFO, { text: "Budget unklar" });
    office.sendMessage(COO, {
      toId: CFO,
      kind: "info",
      text: "Nimm das Budget vom Oktober.",
      replyToId: escalation.id,
    });
    advance(25 * HOUR);
    const result = await p.tick();
    expect(result.forwards).toBe(0);
    expect(result.started).toEqual([]);
  });

  it("über dem CEO gibt es keine Ebene", () => {
    const escalation = office.escalate(COO, { text: "Server voll" });
    expect(escalation.toId).toBe("ceo");
    expect(() => office.forwardEscalation(escalation.id, 24)).toThrow(DomainError);
  });
});

describe("Stillstand und PR-Obergrenze (E36)", () => {
  it("meldet eine offene Aufgabe ohne Fortschritt einmal je Stand", async () => {
    const p = planner();
    const task = office.createTask("ceo", {
      title: "Ohne Bearbeiter",
      description: "Wartet",
      runType: "buero",
    });
    advance(24 * HOUR);
    expect((await p.tick()).notices).toBe(1);
    expect(office.state.messages({ toId: "ceo" }).at(-1)?.text).toContain(
      `Stillstand: Die Aufgabe „Ohne Bearbeiter“ (${task.id}`,
    );
    expect((await p.tick()).notices).toBe(0);
    office.changeTaskStatus("ceo", task.id, "blockiert");
    advance(23 * HOUR);
    expect((await p.tick()).notices).toBe(0);
    advance(HOUR);
    expect((await p.tick()).notices).toBe(1);
  });

  it("startet ab der Obergrenze keine neuen Code-Aufgaben in diesem Repo", async () => {
    const p = planner({}, { prs: 3 });
    office.createTask("ceo", {
      title: "Neues Feature",
      description: "…",
      runType: "werkbank",
      repo: REPO,
      assigneeId: CTO,
    });
    const result = await p.tick();
    expect(result.started).toEqual([]);
    expect(result.notices).toBe(1);
    expect(office.state.messages({ toId: "ceo" }).at(-1)?.text).toContain(
      `PR-Obergrenze erreicht: ${REPO} hat 3`,
    );
  });

  it("setzt begonnene Code-Aufgaben trotz Obergrenze fort", async () => {
    let prs: number | null = null;
    const p = new Planner({
      office,
      requester: supervisor,
      context: (state, agentId, taskId) =>
        buildContext({
          state,
          agentId,
          taskId,
          constitution: CONSTITUTION,
          directives: [],
          books,
          personas,
        }),
      openPullRequests: () => prs,
    });
    const task = office.createTask("ceo", {
      title: "Feature",
      description: "…",
      runType: "werkbank",
      repo: REPO,
      assigneeId: CTO,
    });
    finish(await p.tick(), 0, "error");
    prs = 5;
    advance(20 * MINUTE);
    const result = await p.tick();
    expect(result.started.map((s) => s.taskId)).toEqual([task.id]);
  });

  it("ohne Quelle für PRs greift die Grenze nicht", () => {
    office.createTask("ceo", {
      title: "Feature",
      description: "…",
      runType: "werkbank",
      repo: REPO,
      assigneeId: CTO,
    });
    const result = plan({ state: office.state, now: clock });
    expect(result.wakes.map((w) => w.agentId)).toEqual([CTO]);
    expect(result.notices).toEqual([]);
  });
});

describe("Antrag beim Supervisor (P02)", () => {
  it("wartet nach einer Ablehnung retryMinutes und schreibt keinen Start", async () => {
    const p = planner();
    supervisor.answer = () => Promise.resolve({ decision: "rejected", reason: "Notaus: Pause" });
    send("ceo", COO, "auftrag");
    const rejected = await p.tick();
    expect(rejected.rejected).toEqual([{ agentId: COO, reason: "Notaus: Pause" }]);
    expect(office.state.runStarts()).toEqual([]);
    advance(4 * MINUTE);
    expect((await p.tick()).plan.holds.map((h) => h.reason)).toEqual(["wiederholung"]);
    supervisor.answer = () => Promise.resolve({ decision: "admitted", runId: "run-x" });
    advance(MINUTE);
    expect((await p.tick()).started.map((s) => s.runId)).toEqual(["run-x"]);
  });

  it("meldet einen Transportfehler mit unbekanntem Ausgang und wiederholt nicht sofort", async () => {
    const p = planner();
    supervisor.answer = () => Promise.reject(new IpcTransportError("Zeit abgelaufen", true));
    send("ceo", COO, "auftrag");
    const result = await p.tick();
    expect(result.failed).toEqual([
      { agentId: COO, error: "Zeit abgelaufen", outcomeUnknown: true },
    ]);
    expect((await p.tick()).started).toEqual([]);
    expect(supervisor.requests).toHaveLength(1);
  });

  it("ein Fehler vor dem Senden gilt nicht als unbekannter Ausgang", async () => {
    const p = planner();
    supervisor.answer = () =>
      Promise.reject(
        new IpcCallError("run.request", { code: "invalid_params", message: "kaputt" }, false),
      );
    send("ceo", COO, "auftrag");
    expect((await p.tick()).failed[0]?.outcomeUnknown).toBe(false);
  });

  it("lässt zwei Durchläufe nie gleichzeitig laufen", async () => {
    const p = planner();
    let release: () => void = () => undefined;
    supervisor.answer = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ decision: "admitted", runId: "run-1" });
        };
      });
    send("ceo", COO, "auftrag");
    const first = p.tick();
    const second = p.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(supervisor.requests).toHaveLength(1);
    release();
    expect((await first).started).toHaveLength(1);
    expect((await second).started).toEqual([]);
    expect(supervisor.requests).toHaveLength(1);
  });

  it("supervisorRunRequester ruft run.request", async () => {
    const calls: unknown[] = [];
    const client = {
      call: (method: string, params: unknown) => {
        calls.push([method, params]);
        return Promise.resolve({ decision: "admitted", runId: "run-9" });
      },
    } as unknown as SupervisorClient;
    const params: IpcParams<"run.request"> = {
      agentId: COO,
      runType: "buero",
      taskId: null,
      repo: null,
      model: "sonnet",
      prompt: "Hallo",
    };
    expect(await supervisorRunRequester(client).requestRun(params)).toEqual({
      decision: "admitted",
      runId: "run-9",
    });
    expect(calls).toEqual([["run.request", params]]);
  });
});

describe("run.started im Domänenmodell", () => {
  it("schreibt nur das System, einmal je Lauf, mit Auslösern an den Agenten", () => {
    const message = send("ceo", COO, "auftrag");
    const input = {
      agentId: COO,
      taskId: null,
      runType: "buero" as const,
      model: "sonnet" as const,
      inboxUpToSeq: office.state.lastSeq,
      triggerIds: [message.id],
    };
    expect(() =>
      office.sendMessage("system", { toId: COO, kind: "auftrag", text: "weck dich" }),
    ).toThrow("Das System sendet nur Nachrichten der Art info");
    expect(() => office.recordRunStarted({ ...input, agentId: CFO }, { runId: "run-1" })).toThrow(
      `Auslöser ${message.id} ist nicht an ${CFO} gerichtet`,
    );
    expect(() =>
      office.recordRunStarted({ ...input, runType: "werkbank" }, { runId: "run-1" }),
    ).toThrow(DomainError);
    const started = office.recordRunStarted(input, { runId: "run-1" });
    expect(started).toMatchObject({ runId: "run-1", agentId: COO, triggerIds: [message.id] });
    expect(() => office.recordRunStarted(input, { runId: "run-1" })).toThrow(
      "Lauf run-1 ist bereits gestartet",
    );
    expect(() =>
      new RunEvaluation(office, { ...runInfo(started), agentId: CFO }).finish(outcome("run-1")),
    ).toThrow(`Lauf run-1 gehört ${COO}, nicht ${CFO}`);
  });

  it("bleibt nach dem Neuaufbau aus dem Protokoll gleich", async () => {
    const p = planner();
    send("ceo", COO, "auftrag");
    const result = await p.tick();
    const reopened = Office.open(store, start.building, { now: () => clock });
    expect(reopened.state.runStarts()).toEqual(result.started);
    expect(reopened.state.skipped).toEqual([]);
    // Der Lauf hat noch kein Ende, der Agent gilt also auch nach dem Neuaufbau als beschäftigt.
    expect(plan({ state: reopened.state, now: clock }).holds.map((h) => h.reason)).toEqual([
      "laeuft",
    ]);
  });
});
