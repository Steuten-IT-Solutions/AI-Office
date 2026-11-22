import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOfficeApiServer, PROTOCOL_VERSION } from "../api/mcp-server.ts";
import { RunTokens } from "../api/run-tokens.ts";
import { Office } from "../domain/office.ts";
import { loadStartData, seedStartAgents } from "../domain/start-data.ts";
import { EventStore } from "../events/event-store.ts";
import { IpcCallError } from "../ipc/client.ts";
import type { IpcParams, IpcResult } from "../ipc/protocol.ts";
import {
  CHECK_RUN_FINISHED,
  CHECK_RUN_STARTED,
  CheckRunFollower,
  type CheckRunAccess,
} from "./check-run.ts";
import type { RunAccess } from "./run-follower.ts";

const RUN_ID = "r-00000000000000c1";
const TOKEN = "t".repeat(43);

/**
 * Was das Fake-CLI des Supervisors (`health/fake-cli.ts`, S11b) schreibt, gekürzt auf die Felder,
 * die der Parser liest.
 */
const FAKE_CLI_OUTPUT = [
  {
    type: "system",
    subtype: "init",
    session_id: "s-1",
    claude_code_version: "pruefung",
    tools: ["mcp__office__send_message"],
    mcp_servers: [{ name: "office", status: "connected" }],
    model: "pruefung",
  },
  {
    type: "assistant",
    session_id: "s-1",
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      model: "pruefung",
      content: [{ type: "text", text: "werkzeuge:send_message" }],
    },
  },
  {
    type: "result",
    subtype: "success",
    session_id: "s-1",
    is_error: false,
    num_turns: 1,
    result: "werkzeuge:send_message",
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
  },
]
  .map((line) => `${JSON.stringify(line)}\n`)
  .join("");

let dir: string;
let store: EventStore;
let tokens: RunTokens;

class FakeSupervisor implements CheckRunAccess, RunAccess {
  readonly calls: string[] = [];
  readonly reports: IpcParams<"checkRun.report">[] = [];
  order: string | null = RUN_ID;
  rejectWith: string | null = null;
  nextError: Error | null = null;
  failReports = 0;
  log = FAKE_CLI_OUTPUT;
  /** So viele Abrufe von `run.output` meldet der Lauf noch als laufend. */
  runningPolls = 0;
  end: Extract<IpcResult<"run.output">, { state: "ended" }>["end"] = {
    reason: "Lauf beendet",
    exitCode: 0,
    finishedBy: "normal",
  };

  next(): Promise<IpcResult<"checkRun.next">> {
    this.calls.push("next");
    if (this.nextError !== null) {
      return Promise.reject(this.nextError);
    }
    return Promise.resolve(
      this.order === null ? { state: "none" } : { state: "ordered", runId: this.order },
    );
  }

  request(runId: string): Promise<IpcResult<"checkRun.request">> {
    this.calls.push(`request ${runId}`);
    this.order = null;
    return Promise.resolve(
      this.rejectWith === null
        ? { decision: "admitted", runId }
        : { decision: "rejected", reason: this.rejectWith },
    );
  }

  report(params: IpcParams<"checkRun.report">): Promise<IpcResult<"checkRun.report">> {
    this.calls.push("report");
    if (this.failReports > 0) {
      this.failReports -= 1;
      return Promise.reject(new Error("Socket weg"));
    }
    this.reports.push(params);
    return Promise.resolve({ recorded: true });
  }

  token(runId: string): Promise<IpcResult<"run.token">> {
    this.calls.push(`token ${runId}`);
    return Promise.resolve({
      state: "started",
      officeToken: TOKEN,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  }

  output(runId: string, offset: number): Promise<IpcResult<"run.output">> {
    this.calls.push(`output ${String(offset)}`);
    const data = offset === 0 ? this.log : "";
    const nextOffset = offset + Buffer.byteLength(data, "utf8");
    if (this.runningPolls > 0 && data === "") {
      this.runningPolls -= 1;
      return Promise.resolve({ state: "running", data, nextOffset, truncated: false });
    }
    return Promise.resolve({ state: "ended", data, nextOffset, truncated: false, end: this.end });
  }
}

function follower(supervisor: FakeSupervisor, heads: number[] = []): CheckRunFollower {
  return new CheckRunFollower({
    store,
    access: supervisor,
    runs: supervisor,
    tokens,
    head: {
      report: () => {
        heads.push(store.head().seq);
        supervisor.calls.push("head");
        return Promise.resolve({ reported: store.head(), auditSeq: 1 });
      },
    },
  });
}

const types = () => store.read().map((event) => event.type);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-pruefung-"));
  store = EventStore.open(join(dir, "office.db"));
  tokens = new RunTokens();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Prüflauf, Office-Seite (S11b)", () => {
  it("fordert an, begleitet den Lauf, hält ihn fest und meldet Kopf und Auswertung", async () => {
    const supervisor = new FakeSupervisor();
    const heads: number[] = [];
    const checks = follower(supervisor, heads);
    expect(await checks.poll()).toMatchObject({ started: null, reported: null });

    expect(await checks.fetch()).toMatchObject({ started: RUN_ID });
    expect(checks.following).toBe(RUN_ID);
    expect(types()).toEqual([CHECK_RUN_STARTED]);
    // Kein zweiter Auftrag, solange einer offen ist.
    expect(await checks.fetch()).toMatchObject({ started: null });

    supervisor.runningPolls = 1;
    expect(await checks.poll()).toMatchObject({ reported: null });
    expect(tokens.resolve(TOKEN)).toMatchObject({
      runId: RUN_ID,
      agentId: "pruefung",
      runType: "buero",
      taskId: null,
    });

    const step = await checks.poll();
    expect(step.reported).toEqual({ runId: RUN_ID, exit: "completed", recorded: true });
    expect(types()).toEqual([CHECK_RUN_STARTED, CHECK_RUN_FINISHED]);
    const finished = store.read().at(-1);
    expect(finished).toMatchObject({
      actor: "system",
      runId: RUN_ID,
      payload: { runId: RUN_ID, exit: "completed", invalidLines: 0, resultSubtype: "success" },
    });
    expect(supervisor.reports).toEqual([
      {
        runId: RUN_ID,
        exit: "completed",
        invalidLines: 0,
        migration: {
          databaseVersion: store.migration.databaseVersion,
          codeVersion: store.migration.codeVersion,
          unknownExpand: [],
        },
        finishedSeq: finished?.seq,
      },
    ]);
    // Der Kopf reicht bis zum festgehaltenen Ende und geht vor der Meldung hinaus.
    expect(heads).toEqual([finished?.seq]);
    expect(supervisor.calls.slice(-2)).toEqual(["head", "report"]);
    expect(tokens.hasRun(RUN_ID)).toBe(false);
    expect(checks.following).toBeNull();
    expect(store.verifyChain().ok).toBe(true);
  });

  it("meldet nach einem gescheiterten Bericht erneut, ohne neues Ereignis", async () => {
    const supervisor = new FakeSupervisor();
    supervisor.failReports = 1;
    const checks = follower(supervisor);
    await checks.fetch();
    await expect(checks.poll()).rejects.toThrow("Socket weg");
    expect(checks.following).toBe(RUN_ID);
    expect((await checks.poll()).reported).toMatchObject({ exit: "completed" });
    expect(types()).toEqual([CHECK_RUN_STARTED, CHECK_RUN_FINISHED]);
    expect(supervisor.reports).toHaveLength(1);
  });

  it("wertet fehlende Ergebnisse und abgebrochene Läufe wie jeden Lauf aus", async () => {
    const supervisor = new FakeSupervisor();
    supervisor.log = 'kein json\n{"type":"system","subtype":"init"}\n';
    const checks = follower(supervisor);
    await checks.fetch();
    expect((await checks.poll()).reported).toMatchObject({ exit: "no_result" });
    expect(supervisor.reports[0]).toMatchObject({ exit: "no_result", invalidLines: 1 });

    supervisor.order = "r-00000000000000c2";
    supervisor.log = FAKE_CLI_OUTPUT;
    supervisor.end = { reason: "Lease abgelaufen", exitCode: 124, finishedBy: "lease" };
    await checks.fetch();
    expect((await checks.poll()).reported).toMatchObject({ exit: "aborted" });
  });

  it("übergeht einen Supervisor ohne Prüfläufe und meldet Ablehnungen", async () => {
    const supervisor = new FakeSupervisor();
    supervisor.nextError = new IpcCallError(
      "checkRun.next",
      { code: "unknown_method", message: "unbekannt" },
      true,
    );
    const checks = follower(supervisor);
    expect(await checks.fetch()).toMatchObject({ unavailable: true, started: null });
    supervisor.nextError = new IpcCallError(
      "checkRun.next",
      { code: "not_available", message: "fehlt" },
      true,
    );
    expect(await checks.fetch()).toMatchObject({ unavailable: true });
    supervisor.nextError = new Error("Socket weg");
    await expect(checks.fetch()).rejects.toThrow("Socket weg");

    supervisor.nextError = null;
    supervisor.rejectWith = "Notaus (pause) ist aktiv";
    expect(await checks.fetch()).toMatchObject({ rejected: "Notaus (pause) ist aktiv" });
    expect(types()).toEqual([]);
    expect(checks.following).toBeNull();
  });

  it("gibt dem Token des Prüflaufs an der echten Office-API die Werkzeugliste", async () => {
    const start = loadStartData();
    const office = Office.open(store, start.building);
    seedStartAgents(office, start.agents);
    const server: Server = createOfficeApiServer({
      office,
      tokens,
      gate: { checkEscalationToCeo: () => Promise.resolve(null) },
      log: () => undefined,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const supervisor = new FakeSupervisor();
      supervisor.runningPolls = 1;
      const checks = follower(supervisor);
      await checks.fetch();
      await checks.poll();
      // So fragt das Fake-CLI im Container (S11b).
      const response = await fetch(
        `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": PROTOCOL_VERSION,
            "mcp-method": "tools/list",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: { tools: { name: string }[] } };
      expect(body.result.tools.map((t) => t.name)).toContain("send_message");
      await checks.poll();
      expect(tokens.hasRun(RUN_ID)).toBe(false);
      // Die Ereignisse des Prüflaufs sind keine Domänenereignisse: Das Büro übergeht sie.
      office.sync();
      expect(office.state.skipped).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
