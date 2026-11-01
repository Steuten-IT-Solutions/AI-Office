import { mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "../domain/agent.ts";
import { buildContext } from "../domain/context.ts";
import { Office } from "../domain/office.ts";
import { loadStartBooks, loadStartPersonas } from "../domain/start-content.ts";
import { loadStartData, seedStartAgents } from "../domain/start-data.ts";
import { EventStore } from "../events/event-store.ts";
import {
  ERRORS,
  MAX_CALLS_PER_RUN,
  PROTOCOL_VERSION,
  createOfficeApiServer,
  decodeHeaderValue,
  idempotencyKey,
} from "./mcp-server.ts";
import { RunTokens, type RunGrant } from "./run-tokens.ts";
import { MAX_ESCALATIONS_PER_DAY, type EscalationGate } from "./tools.ts";

const CTO = "jonas-albrecht";
const CFO = "ingrid-wolters";
const COO = "deniz-kaya";
const REPO = "Steuten-IT-Solutions/AI-Office";
const NOW = new Date("2026-11-01T10:00:00Z");

let dir: string;
let store: EventStore;
let office: Office;
let tokens: RunTokens;
let server: Server;
let url: string;
let ceoViaCooOnly: boolean;
let gateCalls: { runId: string; agentId: string; text: string }[];
let gateAnswer: string | null;
/** Antworten des Gates der Reihe nach; danach gilt `gateAnswer`. */
let gateAnswers: (string | null)[];
/** Wenn gesetzt, wartet das Gate auf dieses Versprechen. */
let gateHold: Promise<void> | null;
/** Wenn gesetzt, scheitert das Gate mit diesem Fehler (z. B. Supervisor nicht erreichbar). */
let gateError: Error | null;
/** Uhr des Office; Tests können sie vorstellen. */
let clock: Date;

const gate: EscalationGate = {
  async checkEscalationToCeo(input) {
    gateCalls.push(input);
    if (gateHold !== null) {
      await gateHold;
    }
    if (gateError !== null) {
      throw gateError;
    }
    return gateAnswers.length > 0 ? (gateAnswers.shift() as string | null) : gateAnswer;
  },
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aio-api-"));
  const start = loadStartData();
  store = EventStore.open(join(dir, "office.db"));
  clock = NOW;
  office = Office.open(store, start.building, { now: () => clock });
  seedStartAgents(office, start.agents);
  tokens = new RunTokens();
  ceoViaCooOnly = false;
  gateCalls = [];
  gateAnswer = null;
  gateAnswers = [];
  gateHold = null;
  gateError = null;
  server = createOfficeApiServer({
    office,
    tokens,
    gate,
    ceoViaCooOnly: () => ceoViaCooOnly,
    log: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => server.close(resolve));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function token(agentId: string, overrides: Partial<RunGrant> = {}): string {
  const value = `token-${agentId}-${String(Math.random()).slice(2)}-${"x".repeat(32)}`;
  tokens.register(value, {
    runId: `lauf-${agentId}-${String(Math.random()).slice(2, 8)}`,
    agentId,
    taskId: null,
    runType: "buero",
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    ...overrides,
  });
  return value;
}

let nextId = 1;

interface RpcBody {
  id?: string | number;
  result?: Record<string, unknown> & {
    content?: { type: string; text: string }[];
    isError?: boolean;
    structuredContent?: Record<string, string>;
  };
  error?: { code: number; message: string; data?: unknown };
}

async function rpc(
  bearer: string | null,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: RpcBody | null; headers: Headers }> {
  const name = typeof params["name"] === "string" ? { "mcp-name": params["name"] } : {};
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
      ...name,
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : (JSON.parse(text) as RpcBody),
    headers: response.headers,
  };
}

async function tool(bearer: string, name: string, args: Record<string, unknown>) {
  const reply = await rpc(bearer, "tools/call", { name, arguments: args });
  expect(reply.status).toBe(200);
  const result = reply.body?.result;
  return {
    isError: result?.isError,
    text: result?.content?.[0]?.text ?? "",
    data: result?.structuredContent ?? {},
  };
}

/** Höchstzahl Blöcke à 64 KiB in `streamUntilClosed`: 25 MiB, weit über `MAX_BODY_BYTES`. */
const STREAM_CHUNKS = 400;

/** Sendet einen langen Inhalt, bis der Server die Verbindung schließt oder alles gesendet ist. */
function streamUntilClosed(
  headers: Record<string, string>,
): Promise<{ status: number; written: number }> {
  const chunk = Buffer.alloc(64 * 1024, 120);
  return new Promise((resolve) => {
    let status = 0;
    let written = 0;
    const req = request(url, { method: "POST", headers });
    req.on("response", (res) => {
      status = res.statusCode ?? 0;
      res.resume();
    });
    // Nach dem Schließen meldet das Schreiben EPIPE oder ECONNRESET; das ist hier gewollt.
    req.on("error", () => undefined);
    req.on("close", () => {
      clearInterval(timer);
      resolve({ status, written });
    });
    const timer = setInterval(() => {
      if (written >= STREAM_CHUNKS) {
        clearInterval(timer);
        req.end();
        return;
      }
      written++;
      req.write(chunk);
    }, 2);
  });
}

describe("MCP-Transport (Streamable HTTP, 2026-07-28)", () => {
  it("beantwortet server/discover und tools/list", async () => {
    const t = token(CTO);
    const discover = await rpc(t, "server/discover");
    expect(discover.status).toBe(200);
    expect(discover.headers.get("content-type")).toBe("application/json");
    expect(discover.body?.result).toMatchObject({
      resultType: "complete",
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      cacheScope: "private",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "ai-office" } },
    });
    const list = await rpc(t, "tools/list");
    const tools = list.body?.result?.["tools"] as { name: string; inputSchema: unknown }[];
    expect(tools.map((x) => x.name)).toEqual([
      "send_message",
      "create_task",
      "delegate",
      "handover",
      "escalate",
    ]);
    for (const x of tools) {
      expect(x.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("verlangt ein gültiges Office-Token eines offenen Laufs", async () => {
    const missing = await rpc(null, "tools/list");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    expect((await rpc("falsch".repeat(10), "tools/list")).status).toBe(401);

    const expired = token(CTO, { expiresAt: new Date(NOW.getTime() - 1) });
    expect((await rpc(expired, "tools/list")).status).toBe(401);

    const t = token(CTO, { runId: "lauf-fertig" });
    expect((await rpc(t, "tools/list")).status).toBe(200);
    office.recordRunFinished(
      CTO,
      {
        taskId: null,
        runType: "buero",
        model: "sonnet",
        exit: "completed",
        resultSubtype: "success",
        totalCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        numTurns: 1,
        rateLimitStatus: null,
        invalidLines: 0,
        toolCalls: [],
        inboxUpToSeq: 0,
      },
      { runId: "lauf-fertig" },
    );
    expect((await rpc(t, "tools/list")).status).toBe(401);
    tokens.revoke("lauf-fertig");
  });

  it("lehnt andere HTTP-Methoden, Pfade, Origin und Inhaltstypen ab", async () => {
    const t = token(CTO);
    const auth = { authorization: `Bearer ${t}` };
    expect((await fetch(url, { headers: auth })).status).toBe(405);
    expect((await fetch(url, { method: "DELETE", headers: auth })).status).toBe(405);
    expect((await fetch(url.replace("/mcp", "/anders"), { method: "POST" })).status).toBe(404);
    expect((await rpc(t, "tools/list", {}, { origin: "https://example.com" })).status).toBe(403);
    expect((await rpc(t, "tools/list", {}, { "content-type": "text/plain" })).status).toBe(415);
  });

  it("begrenzt die Größe, prüft JSON und nimmt Benachrichtigungen an", async () => {
    const t = token(CTO);
    const post = (body: string) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
        body,
      });
    const tooBig = await post("x".repeat(300 * 1024));
    expect(tooBig.status).toBe(413);
    expect(tooBig.headers.get("connection")).toBe("close");
    const broken = await post("{kaputt");
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as RpcBody).error?.code).toBe(ERRORS.parse);
    expect((await post("[]")).status).toBe(400);
    const note = await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/x" }));
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
  });

  it("schließt nach 401, 413 und 415 die Verbindung, statt den Rest des Inhalts anzunehmen", async () => {
    const t = token(CTO);
    const json = { "content-type": "application/json" };
    for (const [headers, expected] of [
      [{ ...json, authorization: `Bearer ${t}` }, 413],
      [json, 401],
      [{ "content-type": "text/plain", authorization: `Bearer ${t}` }, 415],
    ] as const) {
      const result = await streamUntilClosed(headers);
      expect(result.status).toBe(expected);
      expect(result.written).toBeLessThan(STREAM_CHUNKS);
    }
  });

  it("verlangt die Fähigkeiten des Clients in _meta", async () => {
    const t = token(CTO);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${t}`,
        "mcp-protocol-version": PROTOCOL_VERSION,
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION } },
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as RpcBody;
    expect(body.id).toBe(7);
    expect(body.error?.code).toBe(ERRORS.invalidParams);
  });

  it("nennt bei einem internen Fehler die id der Anfrage", async () => {
    gateError = new Error("Supervisor nicht erreichbar");
    const reply = await rpc(token(COO), "tools/call", {
      name: "escalate",
      arguments: { text: "Dringend" },
    });
    expect(reply.status).toBe(500);
    expect(reply.body?.id).toBe(nextId - 1);
    expect(reply.body?.error?.code).toBe(ERRORS.internal);
    expect(office.state.escalations()).toEqual([]);
  });

  it("prüft Version und gespiegelte Header gegen den Inhalt", async () => {
    const t = token(CTO);
    const noVersion = await rpc(t, "tools/list", {}, { "mcp-protocol-version": "" });
    expect(noVersion.status).toBe(400);
    expect(noVersion.body?.error?.code).toBe(ERRORS.headerMismatch);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${t}`,
        "mcp-protocol-version": "2025-11-25",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as RpcBody).error).toEqual({
      code: ERRORS.unsupportedVersion,
      message: "Unsupported protocol version",
      data: { supported: [PROTOCOL_VERSION], requested: "2025-11-25" },
    });

    const method = await rpc(t, "tools/list", {}, { "mcp-method": "tools/call" });
    expect(method.status).toBe(400);
    const name = await rpc(
      t,
      "tools/call",
      { name: "send_message", arguments: {} },
      { "mcp-name": "delegate" },
    );
    expect(name.body?.error?.code).toBe(ERRORS.headerMismatch);
    const encoded = await rpc(
      t,
      "tools/call",
      { name: "handover", arguments: { note: "x" } },
      { "mcp-name": `=?base64?${Buffer.from("handover").toString("base64")}?=` },
    );
    expect(encoded.status).toBe(200);

    const unknown = await rpc(t, "initialize");
    expect(unknown.status).toBe(404);
    expect(unknown.body?.error?.code).toBe(ERRORS.methodNotFound);
  });

  it("meldet unbekannte Werkzeuge und falsche Argumente als Protokollfehler", async () => {
    const t = token(CTO);
    expect((await rpc(t, "tools/call", { name: "rm_rf", arguments: {} })).body?.error?.code).toBe(
      ERRORS.invalidParams,
    );
    expect(
      (await rpc(t, "tools/call", { name: "handover", arguments: [] })).body?.error?.code,
    ).toBe(ERRORS.invalidParams);
  });

  it("dekodiert Header im Base64-Format", () => {
    expect(decodeHeaderValue("=?base64?SGVsbG8sIOS4lueVjA==?=")).toBe("Hello, 世界");
    expect(decodeHeaderValue("plain")).toBe("plain");
  });
});

describe("Werkzeuge", () => {
  it("send_message handelt als Agent des Tokens und bucht einen wiederholten Aufruf nur einmal", async () => {
    const t = token(CTO, { runId: "lauf-1" });
    const args = { toId: COO, kind: "info", text: "Tests laufen" };
    const first = await tool(t, "send_message", args);
    expect(first.isError).toBe(false);
    const message = office.state.message(first.data["messageId"] ?? "");
    expect(message).toMatchObject({ fromId: CTO, toId: COO, runId: "lauf-1" });

    const again = await tool(t, "send_message", args);
    expect(again.data).toEqual(first.data);
    expect(office.state.messages()).toHaveLength(1);
    expect(
      store.findByIdempotencyKey(idempotencyKey("lauf-1", "send_message", args)),
    ).toBeDefined();

    const forged = await tool(t, "send_message", { ...args, fromId: "ceo" });
    expect(forged).toMatchObject({ isError: true });
    expect(forged.text).toContain("fromId: unbekanntes Feld");
  });

  it("meldet Regelverstöße als Werkzeugfehler, damit das Modell sie beheben kann", async () => {
    const t = token(CTO);
    const self = await tool(t, "send_message", { toId: CTO, kind: "info", text: "Hallo" });
    expect(self).toMatchObject({ isError: true, text: "Absender und Empfänger sind gleich" });
    const kind = await tool(t, "send_message", { toId: COO, kind: "befehl", text: "x" });
    expect(kind.isError).toBe(true);
    expect(kind.text).toContain("kind");
  });

  it("setzt die Weisung aus E46 um: an den CEO schreibt nur der COO", async () => {
    ceoViaCooOnly = true;
    const blocked = await tool(token(CTO), "send_message", {
      toId: "ceo",
      kind: "info",
      text: "Bericht",
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("E46");
    const allowed = await tool(token(COO), "send_message", {
      toId: "ceo",
      kind: "info",
      text: "Bericht",
    });
    expect(allowed.isError).toBe(false);
  });

  it("legt Aufgaben an, delegiert sie und schreibt die Übergabenotiz zur Aufgabe des Laufs", async () => {
    const coo = token(COO);
    const created = await tool(coo, "create_task", {
      title: "Test reparieren",
      description: "Der Export-Test schlägt fehl.",
      runType: "werkbank",
      repo: REPO,
    });
    expect(created.isError).toBe(false);
    const taskId = created.data["taskId"] ?? "";
    expect(office.state.task(taskId)?.createdBy).toBe(COO);

    const wrong = await tool(coo, "delegate", { taskId, assigneeId: CFO });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("keine Ausstattung für den Lauftyp werkbank");
    expect((await tool(coo, "delegate", { taskId, assigneeId: CTO })).data).toEqual({
      taskId,
      assigneeId: CTO,
    });

    const cto = token(CTO, { taskId, runType: "werkbank", runId: "lauf-cto" });
    const note = await tool(cto, "handover", { note: "Ursache gefunden, Fix folgt" });
    expect(note.isError).toBe(false);
    expect(office.state.task(taskId)?.handover).toMatchObject({
      writtenBy: CTO,
      runId: "lauf-cto",
      note: "Ursache gefunden, Fix folgt",
    });
    const foreign = await tool(coo, "handover", { taskId, note: "Fremd" });
    expect(foreign.isError).toBe(true);
    const noTask = await tool(token(CFO), "handover", { note: "Stand" });
    expect(noTask).toMatchObject({
      isError: true,
      text: "Dieser Lauf hat keine Aufgabe. Gib `taskId` an.",
    });
  });

  it("eskaliert an den COO und den COO an den CEO, nach Prüfung des Supervisors", async () => {
    const fromCto = await tool(token(CTO), "escalate", { text: "Build hängt" });
    expect(fromCto.data["toId"]).toBe(COO);
    expect(gateCalls).toEqual([]);

    const coo = token(COO, { runId: "lauf-coo" });
    const fromCoo = await tool(coo, "escalate", { text: "Kontingent knapp" });
    expect(fromCoo.data["toId"]).toBe("ceo");
    expect(gateCalls).toEqual([{ runId: "lauf-coo", agentId: COO, text: "Kontingent knapp" }]);

    gateAnswer = "Häufigkeit überschritten";
    const rejected = await tool(coo, "escalate", { text: "Noch etwas" });
    expect(rejected).toMatchObject({ isError: true });
    expect(rejected.text).toContain("Häufigkeit überschritten");
    expect(office.state.escalations({ fromId: COO })).toHaveLength(1);
  });

  it("begrenzt Eskalationen je Tag, aber nicht die Wiederholung desselben Aufrufs", async () => {
    const t = token(CFO);
    for (let i = 1; i <= MAX_ESCALATIONS_PER_DAY; i += 1) {
      expect((await tool(t, "escalate", { text: `Problem ${String(i)}` })).isError).toBe(false);
    }
    const repeat = await tool(t, "escalate", { text: "Problem 1" });
    expect(repeat.isError).toBe(false);
    const over = await tool(t, "escalate", { text: "Problem 4" });
    expect(over.isError).toBe(true);
    expect(office.state.escalations({ fromId: CFO })).toHaveLength(MAX_ESCALATIONS_PER_DAY);
  });

  it("zeigt die Eskalation im Postfach des COO und erkennt seine Antwort", async () => {
    const raised = await tool(token(CFO), "escalate", { text: "Budget unklar" });
    const escalationId = raised.data["escalationId"] ?? "";
    const context = buildContext({
      state: office.state,
      agentId: COO,
      taskId: null,
      constitution: "# Verfassung\n\n1. Der CEO ist oberste Instanz.",
      directives: [],
      books: loadStartBooks(),
      personas: loadStartPersonas(),
    });
    expect(context.prompt).toContain("## Eskalation von Ingrid Wolters, CFO (`ingrid-wolters`)");
    expect(context.prompt).toContain("> Budget unklar");

    await tool(token(CTO), "send_message", {
      toId: CFO,
      kind: "info",
      text: "Nicht meine Sache",
      replyToId: escalationId,
    });
    expect(office.state.escalation(escalationId)?.answeredSeq).toBeNull();
    await tool(token(COO), "send_message", {
      toId: CFO,
      kind: "info",
      text: "Freigegeben",
      replyToId: escalationId,
    });
    expect(office.state.escalation(escalationId)?.answeredSeq).toBe(office.state.lastSeq);
  });

  it("begrenzt die Zahl der Aufrufe je Lauf", async () => {
    const t = token(CTO);
    for (let i = 0; i < MAX_CALLS_PER_RUN; i += 1) {
      await rpc(t, "tools/call", { name: "handover", arguments: { note: "x" } });
    }
    const over = await tool(t, "send_message", { toId: COO, kind: "info", text: "x" });
    expect(over.isError).toBe(true);
    expect(over.text).toContain("Zu viele Aufrufe");
    expect(office.state.messages()).toEqual([]);
  });
});

describe("Wiederholungen und Nebenläufigkeit (Review von PR #13)", () => {
  it("prüft das Token nach dem Lesen des Inhalts erneut", async () => {
    const t = token(CTO, { runId: "lauf-langsam" });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: { toId: COO, kind: "info", text: "spät" },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${t}`,
            "mcp-protocol-version": PROTOCOL_VERSION,
            "mcp-method": "tools/call",
            "mcp-name": "send_message",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.write(body.slice(0, 10));
      setTimeout(() => {
        tokens.revoke("lauf-langsam");
        req.end(body.slice(10));
      }, 50);
    });
    expect(status).toBe(401);
    expect(office.state.messages()).toEqual([]);
  });

  it("schreibt keine Eskalation, wenn der Lauf während der Prüfung des Supervisors endet", async () => {
    let release: () => void = () => undefined;
    gateHold = new Promise((resolve) => {
      release = resolve;
    });
    const t = token(COO, { runId: "lauf-gate" });
    const pending = rpc(t, "tools/call", { name: "escalate", arguments: { text: "Dringend" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    tokens.revoke("lauf-gate");
    release();
    expect((await pending).status).toBe(401);
    expect(office.state.escalations()).toEqual([]);
  });

  it("hält die Tagesgrenze auch bei gleichzeitigen Eskalationen an den CEO ein", async () => {
    let release: () => void = () => undefined;
    gateHold = new Promise((resolve) => {
      release = resolve;
    });
    const t = token(COO);
    const calls = [1, 2, 3, 4].map((i) => tool(t, "escalate", { text: `Problem ${String(i)}` }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gateCalls).toHaveLength(4);
    release();
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.isError === false)).toHaveLength(MAX_ESCALATIONS_PER_DAY);
    expect(office.state.escalations({ fromId: COO })).toHaveLength(MAX_ESCALATIONS_PER_DAY);
  });

  it("wendet die Weisung aus E46 nicht auf eine Wiederholung an", async () => {
    const t = token(CTO);
    const args = { toId: "ceo", kind: "info", text: "Bericht" };
    const first = await tool(t, "send_message", args);
    ceoViaCooOnly = true;
    const again = await tool(t, "send_message", args);
    expect(again).toEqual(first);
  });

  it("liefert bei einer wiederholten Delegation das ursprüngliche Ergebnis", async () => {
    const task = office.createTask("ceo", {
      title: "Bericht",
      description: "Monatsbericht",
      runType: "buero",
      assigneeId: COO,
    });
    const coo = token(COO);
    const first = await tool(coo, "delegate", { taskId: task.id, assigneeId: CFO });
    office.delegateTask("ceo", task.id, COO);
    const again = await tool(coo, "delegate", { taskId: task.id, assigneeId: CFO });
    expect(again.data).toEqual(first.data);
    expect(again.data["assigneeId"]).toBe(CFO);
    expect(office.state.task(task.id)?.assigneeId).toBe(COO);
  });

  it("zählt nach dem Supervisor mit dem aktuellen Tag, auch über Mitternacht", async () => {
    // Vier gleichzeitige Eskalationen an den CEO starten kurz vor Mitternacht ...
    clock = new Date("2026-11-02T23:59:59Z");
    const t = token(COO, { expiresAt: new Date("2026-11-04T00:00:00Z") });
    let release: () => void = () => undefined;
    gateHold = new Promise((resolve) => {
      release = resolve;
    });
    const calls = [1, 2, 3, 4].map((i) => tool(t, "escalate", { text: `Nacht ${String(i)}` }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gateCalls).toHaveLength(4);
    // ... und der Supervisor gibt sie erst danach frei. Gezählt wird der Tag, an dem gebucht wird.
    clock = new Date("2026-11-03T00:00:01Z");
    release();
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.isError === false)).toHaveLength(MAX_ESCALATIONS_PER_DAY);
    expect(office.state.escalations().map((e) => e.occurredAt.slice(0, 10))).toEqual(
      Array(MAX_ESCALATIONS_PER_DAY).fill("2026-11-03"),
    );
  });

  it("holt die Freigabe nach, wenn der Weg erst im Befehl zum CEO führt", async () => {
    // Eine andere Instanz nimmt dem COO die Rolle, nachdem das Werkzeug den Weg geprüft hat.
    const other = Office.open(store, loadStartData().building);
    const target = office.escalationTarget.bind(office);
    vi.spyOn(office, "escalationTarget").mockImplementationOnce((actor) => {
      const result = target(actor);
      const coo = other.state.agent(COO) as AgentProfile;
      other.changeProfile("ceo", { ...coo, version: coo.version + 1, role: "Berater" });
      return result;
    });
    gateAnswer = "zu häufig";
    const t = token(CTO);
    const refused = await tool(t, "escalate", { text: "Blockiert" });
    expect(refused.isError).toBe(true);
    expect(gateCalls).toHaveLength(1);
    expect(office.state.escalations()).toEqual([]);

    gateAnswer = null;
    const allowed = await tool(t, "escalate", { text: "Blockiert" });
    expect(allowed.data["toId"]).toBe("ceo");
    expect(gateCalls).toHaveLength(2);
  });

  it("liefert das gebuchte Ergebnis, wenn ein gleicher Aufruf nach der Buchung abgelehnt wird", async () => {
    let release: () => void = () => undefined;
    gateHold = new Promise((resolve) => {
      release = resolve;
    });
    gateAnswers = [null, "zu häufig"];
    const t = token(COO);
    const calls = [1, 2].map(() => tool(t, "escalate", { text: "Dringend" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gateCalls).toHaveLength(2);
    release();
    const [first, second] = await Promise.all(calls);
    expect(first?.isError).toBe(false);
    expect(second).toEqual(first);
    expect(office.state.escalations()).toHaveLength(1);
  });

  it("zählt Eskalationen nach dem Tag des Office, nicht nach der Systemzeit", async () => {
    const t = token(CFO);
    await tool(t, "escalate", { text: "Eins" });
    expect(office.state.escalations()[0]?.occurredAt).toBe(NOW.toISOString());
  });
});

describe("Office-Tokens", () => {
  const grant: RunGrant = {
    runId: "r1",
    agentId: CTO,
    taskId: null,
    runType: "buero",
    expiresAt: new Date(NOW.getTime() + 1000),
  };

  it("lehnt kurze und doppelte Tokens ab und zieht Tokens zurück", () => {
    const registry = new RunTokens();
    expect(() => {
      registry.register("kurz", grant);
    }).toThrow("kürzer als 32");
    registry.register("a".repeat(32), grant);
    expect(() => {
      registry.register("a".repeat(32), { ...grant, runId: "r2" });
    }).toThrow("bereits angemeldet");
    expect(() => {
      registry.register("b".repeat(32), grant);
    }).toThrow("Lauf r1 hat bereits");
    expect(registry.resolve("a".repeat(32), NOW)).toEqual(grant);
    expect(registry.resolve("a".repeat(33), NOW)).toBeNull();
    registry.revoke("r1");
    expect(registry.resolve("a".repeat(32), NOW)).toBeNull();
  });

  it("nimmt abgelaufene Tokens nicht an und räumt sie weg", () => {
    const registry = new RunTokens();
    registry.register("c".repeat(32), grant);
    const later = new Date(NOW.getTime() + 1000);
    expect(registry.resolve("c".repeat(32), later)).toBeNull();
    registry.prune(later);
    registry.register("c".repeat(32), { ...grant, expiresAt: new Date(later.getTime() + 1) });
    expect(registry.resolve("c".repeat(32), later)).not.toBeNull();
  });
});
