import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IpcCallError,
  IpcTransportError,
  SupervisorClient,
  supervisorEscalationGate,
  type SupervisorClientOptions,
} from "./client.ts";
import { MAX_PROMPT_CHARS } from "./protocol.ts";

type Request = { v: number; id: string; method: string; params: Record<string, unknown> };
/** Antwortet auf eine Anfrage mit rohen Zeilen (ohne `\n`), oder mit nichts. */
type Responder = (request: Request, socket: Socket) => string[] | undefined;

let dir: string;
let socketPath: string;
let server: Server | undefined;
let received: Request[];
let connections: number;
let clients: SupervisorClient[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-ipc-client-"));
  socketPath = join(dir, "supervisor.sock");
  received = [];
  connections = 0;
  clients = [];
});

afterEach(async () => {
  for (const client of clients) {
    await client.close().catch(() => undefined);
  }
  await new Promise<void>((done) => {
    if (server === undefined) {
      done();
      return;
    }
    server.close(() => {
      done();
    });
  });
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const ok = (request: Request, result: unknown): string =>
  JSON.stringify({ v: 1, id: request.id, ok: true, result });

const fail = (id: string | null, code: string, message: string, extra = {}): string =>
  JSON.stringify({ v: 1, id, ok: false, error: { code, message, ...extra } });

/** Antwortet wie der Supervisor aus S02 auf `office.reportHead`. */
const reportHead: Responder = (request) => [ok(request, { recorded: true, auditSeq: 7 })];

async function supervisor(respond: Responder): Promise<void> {
  server = createServer((socket) => {
    connections += 1;
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, newline)) as Request;
        buffer = buffer.slice(newline + 1);
        received.push(request);
        const lines = respond(request, socket);
        if (lines !== undefined && !socket.destroyed) {
          socket.write(lines.map((line) => `${line}\n`).join(""));
        }
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((done) => server?.listen(socketPath, done));
}

function client(options: SupervisorClientOptions = {}): SupervisorClient {
  const created = new SupervisorClient({ socketPath, ...options });
  clients.push(created);
  return created;
}

const head = { seq: 3, hash: "a".repeat(64) };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Aufruf sollte scheitern");
}

describe("SupervisorClient", () => {
  it("sendet eine Anfrage in Version 1 und liefert das geprüfte Ergebnis", async () => {
    await supervisor(reportHead);
    const result = await client().call("office.reportHead", head);
    expect(result).toEqual({ recorded: true, auditSeq: 7 });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ v: 1, method: "office.reportHead", params: head });
    expect(received[0]?.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
  });

  it("ordnet gleichzeitige Aufrufe über eine Verbindung richtig zu", async () => {
    await supervisor((request) => {
      const seq = request.params["seq"] as number;
      return [ok(request, { recorded: true, auditSeq: seq + 100 })];
    });
    const supervisorClient = client();
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((seq) => supervisorClient.call("office.reportHead", { ...head, seq })),
    );
    expect(results.map((result) => result.auditSeq)).toEqual([101, 102, 103, 104, 105]);
    expect(connections).toBe(1);
  });

  it("setzt Antworten über Paketgrenzen zusammen und liest mehrere aus einem Paket", async () => {
    let held: Request[] = [];
    await supervisor((request, socket) => {
      held.push(request);
      if (held.length < 2) {
        return undefined;
      }
      const both = held.map((entry) => ok(entry, { recorded: true, auditSeq: 1 })).join("\n");
      held = [];
      // Erst ein Teil der ersten Zeile, dann der Rest mit der zweiten Zeile in einem Paket.
      socket.write(both.slice(0, 10));
      setTimeout(() => socket.write(`${both.slice(10)}\n`), 20);
      return undefined;
    });
    const supervisorClient = client();
    const results = await Promise.all([
      supervisorClient.call("office.reportHead", head),
      supervisorClient.call("office.reportHead", { ...head, seq: 4 }),
    ]);
    expect(results).toHaveLength(2);
  });

  it("prüft Parameter vorher und sendet ungültige Anfragen nicht", async () => {
    await supervisor(reportHead);
    const error = await rejection(
      client().call("office.reportHead", { seq: -1, hash: "kein-hash" }),
    );
    expect(error).toBeInstanceOf(IpcCallError);
    expect(error).toMatchObject({ code: "invalid_params", sent: false });
    expect((error as Error).message).toMatch(/seq/);

    const extra = await rejection(
      client().call("office.reportHead", { ...head, extra: 1 } as typeof head),
    );
    expect(extra).toMatchObject({ code: "invalid_params", sent: false });
    expect(received).toHaveLength(0);
    expect(connections).toBe(0);
  });

  it("sendet keine Zeile über der Obergrenze", async () => {
    await supervisor(reportHead);
    // Steuerzeichen werden in JSON zu sechs Bytes; das Schema erlaubt die Länge trotzdem.
    const prompt = "\u0001".repeat(MAX_PROMPT_CHARS);
    const error = await rejection(
      client().call("run.request", {
        agentId: "cto",
        runType: "buero",
        taskId: null,
        repo: null,
        model: "sonnet",
        prompt,
      }),
    );
    expect(error).toMatchObject({ code: "invalid_frame", sent: false });
    expect(received).toHaveLength(0);
  });

  it("meldet Fehler des Supervisors mit Code, ohne die Verbindung aufzugeben", async () => {
    await supervisor((request) =>
      request.method === "office.reportHead"
        ? [
            fail(request.id, "unsupported_version", "Protokollversion 1 wird nicht unterstützt", {
              supported: [2],
            }),
          ]
        : [fail(request.id, "not_available", "noch nicht umgesetzt")],
    );
    const supervisorClient = client();
    const version = await rejection(supervisorClient.call("office.reportHead", head));
    expect(version).toBeInstanceOf(IpcCallError);
    expect(version).toMatchObject({ code: "unsupported_version", supported: [2], sent: true });

    const missing = await rejection(
      supervisorClient.call("workplaces.change", {
        roomId: "buero-cto",
        workplaces: 2,
        equipment: [],
      }),
    );
    expect(missing).toMatchObject({ code: "not_available", sent: true });
    expect(connections).toBe(1);
  });

  it("ordnet eine Fehlerantwort ohne ID der ältesten offenen Anfrage zu", async () => {
    await supervisor(() => [fail(null, "invalid_request", "id: Ungültig")]);
    const error = await rejection(client().call("office.reportHead", head));
    expect(error).toMatchObject({ code: "invalid_request", sent: true });
  });

  it.each([
    ["kein JSON", () => ["{kaputt"]],
    [
      "falsche ID",
      (request: Request) => [ok({ ...request, id: "andere" }, { recorded: true, auditSeq: 1 })],
    ],
    [
      "Erfolg ohne ID",
      (request: Request) => [ok({ ...request, id: null as unknown as string }, {})],
    ],
    [
      "unbekanntes Feld",
      (request: Request) => [
        JSON.stringify({
          v: 1,
          id: request.id,
          ok: true,
          result: { recorded: true, auditSeq: 1 },
          x: 1,
        }),
      ],
    ],
    [
      "falsche Version",
      (request: Request) => [
        JSON.stringify({ v: 2, id: request.id, ok: true, result: { recorded: true, auditSeq: 1 } }),
      ],
    ],
    ["Ergebnis passt nicht zum Schema", (request: Request) => [ok(request, { recorded: true })]],
    ["unbekannter Fehlercode", (request: Request) => [fail(request.id, "teapot", "x")]],
  ] as [string, Responder][])(
    "behandelt eine ungültige Antwort als kaputte Verbindung: %s",
    async (_name, respond) => {
      let calls = 0;
      await supervisor((request, socket) => {
        calls += 1;
        return calls === 1 ? respond(request, socket) : reportHead(request, socket);
      });
      const supervisorClient = client();
      const first = supervisorClient.call("office.reportHead", head);
      const error = await rejection(first);
      expect(error).toBeInstanceOf(IpcTransportError);
      expect(error).toMatchObject({ outcomeUnknown: true });
      expect((error as Error).message).toMatch(/Protokollfehler/);

      // Der nächste Aufruf baut eine neue Verbindung auf.
      await expect(supervisorClient.call("office.reportHead", head)).resolves.toMatchObject({
        recorded: true,
      });
      expect(connections).toBe(2);
    },
  );

  it("schließt die Verbindung bei einer Antwort ohne offene Anfrage", async () => {
    let calls = 0;
    await supervisor((request) => {
      calls += 1;
      const answer = ok(request, { recorded: true, auditSeq: 1 });
      return calls === 1 ? [answer, answer] : [answer];
    });
    const supervisorClient = client();
    await expect(supervisorClient.call("office.reportHead", head)).resolves.toMatchObject({
      auditSeq: 1,
    });
    await new Promise((done) => setTimeout(done, 20));
    await expect(supervisorClient.call("office.reportHead", head)).resolves.toMatchObject({
      auditSeq: 1,
    });
    expect(connections).toBe(2);
  });

  it("lehnt eine zu lange Antwortzeile ab", async () => {
    await supervisor((_request, socket) => {
      socket.write("x".repeat(600));
      setTimeout(() => socket.write("x".repeat(600)), 10);
      return undefined;
    });
    const error = await rejection(client({ maxFrameBytes: 1000 }).call("office.reportHead", head));
    expect(error).toBeInstanceOf(IpcTransportError);
    expect((error as Error).message).toMatch(/länger als 1000 Bytes/);
  });

  it("meldet einen fehlenden Supervisor, ohne dass etwas gesendet wurde", async () => {
    const error = await rejection(client().call("office.reportHead", head));
    expect(error).toBeInstanceOf(IpcTransportError);
    expect(error).toMatchObject({ outcomeUnknown: false });
    expect((error as Error).message).toMatch(/nicht erreichbar \(ENOENT\)/);
  });

  it("meldet einen Abbruch nach dem Senden als unbekanntes Ergebnis", async () => {
    await supervisor((_request, socket) => {
      socket.destroy();
      return undefined;
    });
    const supervisorClient = client();
    const results = await Promise.allSettled([
      supervisorClient.call("office.reportHead", head),
      supervisorClient.call("office.reportHead", { ...head, seq: 4 }),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(IpcTransportError);
        expect(result.reason).toMatchObject({ outcomeUnknown: true });
      }
    }
  });

  it("gibt nach der Wartezeit auf und wiederholt nicht", async () => {
    await supervisor(() => undefined);
    const supervisorClient = client({ timeoutMs: 50 });
    const error = await rejection(supervisorClient.call("office.reportHead", head));
    expect(error).toBeInstanceOf(IpcTransportError);
    expect(error).toMatchObject({ outcomeUnknown: true });
    expect((error as Error).message).toMatch(/keine Antwort nach 50 ms/);
    await new Promise((done) => setTimeout(done, 50));
    expect(received).toHaveLength(1);
  });

  it("wartet beim Schließen auf offene Aufrufe und nimmt danach keine mehr an", async () => {
    let answer: (() => void) | undefined;
    await supervisor((request, socket) => {
      answer = () => socket.write(`${ok(request, { recorded: true, auditSeq: 9 })}\n`);
      return undefined;
    });
    const supervisorClient = client();
    const pending = supervisorClient.call("office.reportHead", head);
    await new Promise((done) => setTimeout(done, 20));
    let closed = false;
    const closing = supervisorClient.close().then(() => {
      closed = true;
    });
    await new Promise((done) => setTimeout(done, 20));
    expect(closed).toBe(false);
    answer?.();
    await expect(pending).resolves.toEqual({ recorded: true, auditSeq: 9 });
    await closing;
    const after = await rejection(supervisorClient.call("office.reportHead", head));
    expect(after).toBeInstanceOf(IpcTransportError);
    expect((after as Error).message).toMatch(/geschlossen/);
  });
});

describe("supervisorEscalationGate", () => {
  const request = { runId: "r-1", agentId: "coo", text: "Bitte entscheiden" };

  it("gibt null bei Erlaubnis und den Grund bei Ablehnung", async () => {
    let allowed = true;
    await supervisor((incoming) => [
      ok(incoming, allowed ? { allowed: true } : { allowed: false, reason: "Weisung E46" }),
    ]);
    const gate = supervisorEscalationGate(client());
    await expect(gate.checkEscalationToCeo(request)).resolves.toBeNull();
    expect(received[0]).toMatchObject({ method: "escalation.checkToCeo", params: request });
    allowed = false;
    await expect(gate.checkEscalationToCeo(request)).resolves.toBe("Weisung E46");
  });

  it("wirft, wenn der Supervisor nicht zustimmt oder nicht antwortet", async () => {
    await supervisor((incoming) => [fail(incoming.id, "not_available", "kommt mit S03")]);
    const gate = supervisorEscalationGate(client());
    await expect(gate.checkEscalationToCeo(request)).rejects.toBeInstanceOf(IpcCallError);
  });
});
