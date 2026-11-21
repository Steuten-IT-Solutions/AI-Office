import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunTokens } from "../api/run-tokens.ts";
import { buildContext } from "../domain/context.ts";
import { Office } from "../domain/office.ts";
import { loadStartBooks, loadStartPersonas } from "../domain/start-content.ts";
import { loadStartData, seedStartAgents } from "../domain/start-data.ts";
import { EventStore } from "../events/event-store.ts";
import { IpcTransportError } from "../ipc/client.ts";
import type { IpcResult } from "../ipc/protocol.ts";
import { loadFixture } from "../llm/fake-runner.ts";
import { Planner, type RunRequester } from "../planner/planner.ts";
import { RunFollower, type RunAccess } from "./run-follower.ts";

const COO = "deniz-kaya";
const CFO = "ingrid-wolters";
const books = loadStartBooks();
const personas = loadStartPersonas();

let dir: string;
let store: EventStore;
let office: Office;
let clock: Date;
let access: FakeAccess;
let tokens: RunTokens;

type Phase = "waiting" | "running" | "ended" | "unknown";
type End = Extract<IpcResult<"run.output">, { state: "ended" }>["end"];

interface FakeRun {
  phase: Phase;
  log: Buffer;
  /** Bis hierher ist das Rohprotokoll „geschrieben“. */
  written: number;
  end: End;
  truncated: boolean;
  officeToken: string;
}

/** Supervisor-Attrappe für `run.token` und `run.output`, schneidet wie `readSlice` in S05. */
class FakeAccess implements RunAccess {
  readonly runs = new Map<string, FakeRun>();
  readonly calls: string[] = [];
  sliceBytes = 128 * 1024;
  failOutput = 0;
  /** Liefert einmal ein `nextOffset`, das nicht vorrückt. */
  stuck = false;

  add(runId: string, text: string, phase: Phase = "waiting"): FakeRun {
    const log = Buffer.from(text, "utf8");
    const run: FakeRun = {
      phase,
      log,
      written: log.length,
      end: { reason: "Lauf beendet", exitCode: 0, finishedBy: "normal" },
      truncated: false,
      officeToken: randomBytes(32).toString("base64url"),
    };
    this.runs.set(runId, run);
    return run;
  }

  token(runId: string): Promise<IpcResult<"run.token">> {
    this.calls.push(`token ${runId}`);
    const run = this.runs.get(runId);
    if (run === undefined || run.phase === "unknown") {
      return Promise.resolve({ state: "unknown" });
    }
    if (run.phase === "ended") {
      return Promise.resolve({ state: "ended", reason: run.end.reason });
    }
    run.phase = "running";
    return Promise.resolve({
      state: "started",
      officeToken: run.officeToken,
      expiresAt: new Date(clock.getTime() + 3_600_000).toISOString(),
    });
  }

  output(runId: string, offset: number): Promise<IpcResult<"run.output">> {
    this.calls.push(`output ${runId} ${String(offset)}`);
    if (this.failOutput > 0) {
      this.failOutput -= 1;
      return Promise.reject(new IpcTransportError("Verbindung abgebrochen", true));
    }
    const run = this.runs.get(runId);
    if (run === undefined || run.phase === "unknown") {
      return Promise.resolve({ state: "unknown" });
    }
    let chunk = run.log.subarray(offset, Math.min(offset + this.sliceBytes, run.written));
    const newline = chunk.lastIndexOf(0x0a);
    if (newline !== -1) {
      chunk = chunk.subarray(0, newline + 1);
    }
    let nextOffset = offset + chunk.length;
    if (this.stuck && chunk.length > 0) {
      this.stuck = false;
      nextOffset = offset;
    }
    const slice = { data: chunk.toString("utf8"), nextOffset, truncated: run.truncated };
    if (run.phase === "ended") {
      return Promise.resolve({ state: "ended", ...slice, end: run.end });
    }
    return Promise.resolve({ state: run.phase, ...slice });
  }
}

let nextRun = 0;

/** Lässt jeden Antrag zu, mit Lauf-IDs wie in der Admission. */
const admitAll: RunRequester = {
  requestRun() {
    nextRun += 1;
    return Promise.resolve({
      decision: "admitted",
      runId: `r-${nextRun.toString(16).padStart(16, "0")}`,
    });
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-run-follower-"));
  const start = loadStartData();
  store = EventStore.open(join(dir, "office.db"));
  clock = new Date("2026-11-21T08:00:00.000Z");
  office = Office.open(store, start.building, { now: () => clock });
  seedStartAgents(office, start.agents);
  access = new FakeAccess();
  tokens = new RunTokens();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function follower(options: { maxSlicesPerPoll?: number; tokens?: RunTokens } = {}): RunFollower {
  return new RunFollower({
    office,
    access,
    tokens: options.tokens ?? tokens,
    ...(options.maxSlicesPerPoll === undefined
      ? {}
      : { maxSlicesPerPoll: options.maxSlicesPerPoll }),
  });
}

/** Weckt den Empfänger über den Planer und liefert die Lauf-ID aus `run.started`. */
async function startRun(toId = COO): Promise<string> {
  office.sendMessage("ceo", { toId, kind: "auftrag", text: `Auftrag an ${toId}` });
  const planner = new Planner({
    office,
    requester: admitAll,
    context: (state, agentId, taskId) =>
      buildContext({
        state,
        agentId,
        taskId,
        constitution: "# Verfassung",
        directives: [],
        books,
        personas,
      }),
  });
  const result = await planner.tick();
  const runId = result.started[0]?.runId;
  expect(runId).toBeDefined();
  return runId as string;
}

describe("RunFollower", () => {
  it("holt das Token, liest die Ausgabe in Ausschnitten und schließt den Lauf ab", async () => {
    const runId = await startRun();
    const run = access.add(runId, loadFixture("buero-erfolg"));
    run.written = 0;
    const f = follower();

    const first = await f.poll();
    expect(first.registered).toEqual([runId]);
    expect(first.finished).toEqual([]);
    expect(access.calls).toEqual([`token ${runId}`, `output ${runId} 0`]);
    // Die Office-API erkennt den Lauf am Token, mit der Identität aus `run.started`.
    expect(tokens.resolve(run.officeToken, clock)).toMatchObject({
      runId,
      agentId: COO,
      taskId: null,
      runType: "buero",
    });

    // Der Lauf schreibt; die Gedankenblase entsteht schon während des Laufs.
    run.written = run.log.length;
    expect((await f.poll()).finished).toEqual([]);
    expect(office.state.thoughts(runId).map((t) => t.text)).toEqual([
      "Ich übernehme die Anforderung und lege eine Aufgabe für den CTO an.",
    ]);
    expect(office.state.run(runId)).toBeUndefined();

    run.phase = "ended";
    const last = await f.poll();
    expect(last.failed).toEqual([]);
    expect(last.finished).toHaveLength(1);
    expect(last.finished[0]?.end).toEqual({
      reason: "Lauf beendet",
      exitCode: 0,
      finishedBy: "normal",
      truncated: false,
    });
    expect(office.state.run(runId)).toMatchObject({
      agentId: COO,
      exit: "completed",
      totalCostUsd: 0.0412,
      numTurns: 1,
    });
    // Token zurückgezogen, der Lauf wird nicht mehr abgefragt.
    expect(tokens.resolve(run.officeToken, clock)).toBeNull();
    expect(f.following).toEqual([]);
    const calls = access.calls.length;
    expect(await f.poll()).toEqual({ registered: [], finished: [], failed: [] });
    expect(access.calls).toHaveLength(calls);
  });

  it("setzt Zeilen über Ausschnitte hinweg zusammen und begrenzt Ausschnitte je Durchlauf", async () => {
    const runId = await startRun();
    const text = loadFixture("buero-erfolg");
    access.add(runId, text, "ended");
    // Kleiner als jede Zeile: Jeder Ausschnitt endet mitten in einer Zeile.
    access.sliceBytes = 64;
    const f = follower({ maxSlicesPerPoll: 4 });
    const slices = Math.ceil(Buffer.byteLength(text, "utf8") / 64);

    let polls = 0;
    while (office.state.run(runId) === undefined) {
      const result = await f.poll();
      expect(result.failed).toEqual([]);
      polls += 1;
      expect(polls).toBeLessThan(100);
    }
    // Ein Durchlauf liest höchstens 4 Ausschnitte; zuletzt kommt der leere mit `ended`.
    expect(polls).toBe(Math.ceil((slices + 1) / 4));
    expect(office.state.run(runId)).toMatchObject({ exit: "completed", invalidLines: 0 });
    expect(office.state.thoughts(runId)).toHaveLength(1);
  });

  it("wertet Lease und Stopp als abgebrochen", async () => {
    const lease = await startRun(COO);
    const stop = await startRun(CFO);
    access.add(lease, loadFixture("buero-erfolg"), "ended").end = {
      reason: "Lease abgelaufen",
      exitCode: 0,
      finishedBy: "lease",
    };
    access.add(stop, loadFixture("abgestuerzt"), "ended").end = {
      reason: "Notaus (stop)",
      exitCode: 130,
      finishedBy: "stopp",
    };
    const result = await follower().poll();
    expect(result.finished.map((r) => [r.run.runId, r.run.exit])).toEqual([
      [lease, "aborted"],
      [stop, "aborted"],
    ]);
  });

  it("schließt einen ungestarteten oder unbekannten Lauf ohne Ergebnis ab", async () => {
    const unstarted = await startRun(COO);
    const unknown = await startRun(CFO);
    access.add(unstarted, "", "ended").end = {
      reason: "Token nicht abgeholt",
      exitCode: null,
      finishedBy: null,
    };
    const result = await follower().poll();
    expect(result.registered).toEqual([]);
    expect(result.finished.map((r) => [r.run.runId, r.run.exit, r.end?.reason ?? null])).toEqual([
      [unstarted, "no_result", "Token nicht abgeholt"],
      [unknown, "no_result", null],
    ]);
    expect(office.state.run(unknown)).toMatchObject({ totalCostUsd: 0, numTurns: 0 });
  });

  it("versucht einen gescheiterten Abruf am selben Offset noch einmal", async () => {
    const runId = await startRun();
    const run = access.add(runId, loadFixture("buero-erfolg"), "running");
    const f = follower();
    await f.poll();
    const offset = run.log.length;

    access.failOutput = 1;
    const failed = await f.poll();
    expect(failed.failed).toEqual([{ runId, error: "Verbindung abgebrochen" }]);
    expect(f.following).toEqual([runId]);

    run.phase = "ended";
    const result = await f.poll();
    expect(result.finished).toHaveLength(1);
    expect(access.calls.slice(-2)).toEqual([
      `output ${runId} ${String(offset)}`,
      `output ${runId} ${String(offset)}`,
    ]);
    // `run.token` nur einmal: Der Stand blieb erhalten.
    expect(access.calls.filter((c) => c.startsWith("token"))).toHaveLength(1);
  });

  it("beginnt nach einem Fehler der Auswertung von vorn, ohne doppelt zu schreiben", async () => {
    const runId = await startRun();
    access.add(runId, loadFixture("buero-erfolg"), "ended");
    access.stuck = true;
    const f = follower();
    const failed = await f.poll();
    expect(failed.failed[0]?.error).toMatch(/Offset rückt nicht vor/);
    expect(f.following).toEqual([]);

    const result = await f.poll();
    expect(result.failed).toEqual([]);
    expect(result.finished).toHaveLength(1);
    expect(access.calls.filter((c) => c === `output ${runId} 0`)).toHaveLength(2);
  });

  it("nimmt offene Läufe nach einem Neustart des Office wieder auf", async () => {
    const runId = await startRun();
    const run = access.add(runId, loadFixture("buero-erfolg"), "running");
    await follower().poll();
    expect(office.state.thoughts(runId)).toHaveLength(1);

    // Neues Office auf derselben DB, neue Token-Ablage: Der Lauf läuft weiter.
    const restarted = Office.open(store, loadStartData().building, { now: () => clock });
    const fresh = new RunTokens();
    const f = new RunFollower({ office: restarted, access, tokens: fresh });
    const result = await f.poll();
    expect(result.registered).toEqual([runId]);
    expect(fresh.resolve(run.officeToken, clock)?.runId).toBe(runId);

    run.phase = "ended";
    expect((await f.poll()).finished).toHaveLength(1);
    // Von vorn gelesen, aber dieselbe Gedankenblase nur einmal.
    expect(restarted.state.thoughts(runId)).toHaveLength(1);
    expect(restarted.state.run(runId)).toMatchObject({ exit: "completed" });
  });

  it("lässt Durchläufe nacheinander laufen", async () => {
    const runId = await startRun();
    access.add(runId, loadFixture("buero-erfolg"), "ended");
    const f = follower();
    const [a, b] = await Promise.all([f.poll(), f.poll()]);
    expect(a.finished).toHaveLength(1);
    expect(b).toEqual({ registered: [], finished: [], failed: [] });
  });

  it("lehnt eine unsinnige Zahl Ausschnitte ab", () => {
    expect(() => follower({ maxSlicesPerPoll: 0 })).toThrow(/maxSlicesPerPoll/);
  });
});
