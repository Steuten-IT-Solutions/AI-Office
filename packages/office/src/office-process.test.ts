import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OfficeConfig } from "./config.ts";
import { EventStore } from "./events/event-store.ts";
import { HeadReporter } from "./events/head-reporter.ts";
import {
  hashPassword,
  isPasswordHash,
  readPasswordFile,
  writePasswordFile,
} from "./gateway/password.ts";
import { StaticFiles } from "./gateway/static-files.ts";
import type { LogFields, Logger } from "./log.ts";
import { startOffice, type RunningOffice } from "./office-process.ts";
import { passwordCommand } from "./password-command.ts";

const COO = "deniz-kaya";
const RUN = "r-00000000000000c1";
const TOKEN = "A".repeat(43);
const MAIN = join(import.meta.dirname, "main.ts");
const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1 };
const HOST = "office.test:8444";
const ORIGIN = `https://${HOST}`;
const PASSWORT = "ein langes Passwort";

type Request = { v: number; id: string; method: string; params: Record<string, unknown> };
type Answer = { result: unknown } | { error: { code: string; message: string } };

let dir: string;
let config: OfficeConfig;
let server: Server | undefined;
let received: Request[];
let answer: (request: Request) => Answer;
let logs: { level: string; message: string; fields: LogFields }[];
let running: RunningOffice | undefined;

function logger(): Logger {
  const entry =
    (level: string) =>
    (message: string, fields: LogFields = {}) => {
      logs.push({ level, message, fields });
    };
  return { debug: entry("debug"), info: entry("info"), warn: entry("warn"), error: entry("error") };
}

/** Supervisor-Double am Socket: beantwortet jede Anfrage mit `answer`. */
async function supervisor(): Promise<void> {
  server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
        const req = JSON.parse(buffer.slice(0, nl)) as Request;
        buffer = buffer.slice(nl + 1);
        received.push(req);
        const reply = answer(req);
        socket.write(
          `${JSON.stringify({ v: 1, id: req.id, ...("result" in reply ? { ok: true, result: reply.result } : { ok: false, error: reply.error }) })}\n`,
        );
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((done) => server?.listen(config.socketPath, done));
}

/** Antworten wie ein Supervisor mit Container-Manager, aber ohne Git-Gate und Merge-Gate. */
function defaultAnswer(req: Request): Answer {
  switch (req.method) {
    case "office.reportHead":
      return { result: { recorded: true, auditSeq: received.length } };
    case "run.request":
      return { result: { decision: "admitted", runId: RUN } };
    case "run.token":
      return {
        result: { state: "started", officeToken: TOKEN, expiresAt: "2099-01-01T00:00:00.000Z" },
      };
    case "run.output":
      return {
        result: {
          state: "ended",
          data: "",
          nextOffset: req.params["offset"],
          truncated: false,
          end: { reason: "Container beendet", exitCode: 0, finishedBy: "normal" },
        },
      };
    case "fingerprints.add":
      return { result: { added: (req.params["hashes"] as unknown[]).length, total: 1 } };
    default:
      return { error: { code: "not_available", message: `${req.method} gibt es hier nicht` } };
  }
}

async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error(
        `Zeit abgelaufen: ${what}; Protokoll: ${JSON.stringify(logs)}; Anfragen: ${received.map((r) => r.method).join(",")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function http(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Reply> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: HOST,
          ...(text === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

const start = (overrides: Partial<OfficeConfig> = {}) =>
  startOffice(
    { ...config, ...overrides },
    {
      log: logger(),
      web: new StaticFiles(join(dir, "kein-build")),
      // Lange Abstände: Die Tests stoßen den Takt selbst an oder warten auf den Start.
      intervals: { planner: 60_000, runs: 60_000 },
      closeTimeoutMs: 200,
    },
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-office-process-"));
  config = {
    dbPath: join(dir, "office.db"),
    passwordFile: join(dir, "ceo-passwort"),
    constitutionPath: join(dir, "verfassung.md"),
    socketPath: join(dir, "supervisor.sock"),
    webHost: HOST,
    gatewayPort: 0,
    apiPort: 0,
    consoleUrl: null,
    logLevel: "info",
  };
  writeFileSync(config.constitutionPath, "# Verfassung\n\n1. Der CEO ist oberste Instanz.\n");
  received = [];
  answer = defaultAnswer;
  logs = [];
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
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

describe("startOffice", () => {
  it("startet Gateway, Office-API und Takt und begleitet einen Lauf bis zum Ende", async () => {
    writePasswordFile(config.passwordFile, await hashPassword(PASSWORT, FAST_SCRYPT));
    await supervisor();
    running = await start();
    const { office, gatewayPort, apiPort } = running;
    expect(office.state.agent(COO)).toBeDefined();

    // Takt beim Start: Kopf der Kette an den Supervisor (E38).
    await until(() => received.some((r) => r.method === "office.reportHead"), "office.reportHead");
    const head = received.find((r) => r.method === "office.reportHead")?.params ?? {};
    expect(head["seq"]).toBe(office.state.lastSeq);
    expect(head["hash"]).toMatch(/^[0-9a-f]{64}$/);

    // Gateway nur mit dem Namen des Webinterface im Host, Office-API nur mit Office-Token.
    expect((await http(gatewayPort, "GET", "/api/session", { host: "127.0.0.1" })).status).toBe(
      421,
    );
    expect((await http(apiPort, "POST", "/mcp", {}, {})).status).toBe(401);

    // Der CEO schreibt dem COO über das Webinterface. Der Planer läuft im Test nur alle 60 s;
    // den Antrag stößt die Nachricht selbst an.
    const login = await http(
      gatewayPort,
      "POST",
      "/api/login",
      { origin: ORIGIN },
      { password: PASSWORT },
    );
    expect(login.status).toBe(200);
    const cookie = String((login.headers["set-cookie"] as string[])[0]).split(";")[0] as string;
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken;
    const chat = await http(
      gatewayPort,
      "POST",
      "/api/chat",
      { origin: ORIGIN, cookie, "x-csrf-token": csrf },
      { to: COO, text: "Bitte schreib mir bis morgen einen kurzen Bericht über das Büro" },
    );
    expect(chat.status).toBe(201);

    // Antrag, Token, Ausgabe, Abschluss.
    await until(() => office.state.run(RUN) !== undefined, "run.finished");
    const methods = received.map((r) => r.method);
    expect(methods.indexOf("run.request")).toBeLessThan(methods.indexOf("run.token"));
    expect(methods.indexOf("run.token")).toBeLessThan(methods.indexOf("run.output"));
    const req = received.find((r) => r.method === "run.request");
    expect(req?.params).toMatchObject({ agentId: COO, runType: "buero", taskId: null });
    expect(req?.params["prompt"]).toContain("1. Der CEO ist oberste Instanz.");
    expect(req?.params["prompt"]).toContain("Bericht über das Büro");

    // Nach dem Laufende meldet der Takt die Fingerabdrücke des CEO-Chats (S08).
    await until(() => received.some((r) => r.method === "fingerprints.add"), "fingerprints.add");
    expect(received.find((r) => r.method === "fingerprints.add")?.params).toMatchObject({
      source: "ceo_chat",
    });
    expect(logs.filter((l) => l.level === "warn" || l.level === "error")).toEqual([
      expect.objectContaining({
        message: "Webinterface nicht gebaut (pnpm --filter @ai-office/office build:web)",
      }),
    ]);

    await running.stop();
    await running.stop();
    running = undefined;
    for (const port of [gatewayPort, apiPort]) {
      await expect(http(port, "GET", "/")).rejects.toThrow();
    }
    expect(logs.at(-1)?.message).toBe("Office beendet");
    // Die Datenbank ist geschlossen und lässt sich wieder öffnen.
    const store = EventStore.open(config.dbPath);
    expect(store.verifyChain().ok).toBe(true);
    store.close();
  });

  it("startet ohne Verfassung nicht und legt dann keine Datenbank an", async () => {
    rmSync(config.constitutionPath);
    await expect(start()).rejects.toThrow(/Verfassung unter .* nicht lesbar/);
    writeFileSync(config.constitutionPath, "  \n");
    await expect(start()).rejects.toThrow(/ist leer/);
    expect(existsSync(config.dbPath)).toBe(false);
  });

  it("schließt alles wieder, wenn ein Port belegt ist", async () => {
    const blocker = createServer();
    await new Promise<void>((done) => blocker.listen(0, "127.0.0.1", done));
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(start({ gatewayPort: port })).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise<void>((done) =>
        blocker.close(() => {
          done();
        }),
      );
    }
    // Die Datenbank ist wieder frei: Ein neuer Start gelingt.
    await supervisor();
    running = await start();
    expect(running.gatewayPort).not.toBe(port);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "Kein Passwort für den CEO eingerichtet; Anmeldung erst nach `main.ts passwort`",
      }),
    );
  });
});

describe("HeadReporter", () => {
  it("meldet nur einen neuen Kopf und nach einem Fehler erneut", async () => {
    const store = EventStore.open(join(dir, "kopf.db"));
    const reports: unknown[] = [];
    let fail = false;
    const reporter = new HeadReporter({
      store,
      access: {
        reportHead(params) {
          if (fail) {
            return Promise.reject(new Error("Socket weg"));
          }
          reports.push(params);
          return Promise.resolve({ recorded: true, auditSeq: reports.length });
        },
      },
    });
    try {
      expect(await reporter.report()).toEqual({
        reported: { seq: 0, hash: "0".repeat(64) },
        auditSeq: 1,
      });
      expect(await reporter.report()).toEqual({ reported: null, auditSeq: null });
      const event = store.append({ type: "test.ereignis", actor: "system", payload: {} });
      fail = true;
      await expect(reporter.report()).rejects.toThrow("Socket weg");
      fail = false;
      expect(await reporter.report()).toEqual({
        reported: { seq: event.seq, hash: event.hash },
        auditSeq: 2,
      });
      expect(reports).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

describe("passwordCommand", () => {
  it("liest ohne Terminal die erste Zeile und speichert nur den Hash", async () => {
    let shown = "";
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        shown += chunk.toString("utf8");
        done();
      },
    });
    await passwordCommand({
      path: config.passwordFile,
      input: Readable.from(["ein langes Passwort\r\nzweite Zeile\n"]),
      output,
      scrypt: FAST_SCRYPT,
    });
    const stored = readPasswordFile(config.passwordFile);
    expect(stored).not.toBeNull();
    expect(isPasswordHash(stored as string)).toBe(true);
    expect(stored).not.toContain("Passwort");
    expect(shown).toBe(`Passwort gespeichert in ${config.passwordFile}\n`);
    await expect(
      passwordCommand({
        path: config.passwordFile,
        input: Readable.from(["kurz\n"]),
        output,
        scrypt: FAST_SCRYPT,
      }),
    ).rejects.toThrow("mindestens 12 Zeichen");
    expect(readPasswordFile(config.passwordFile)).toBe(stored);
  });
});

describe("main.ts", () => {
  const env = () => ({
    PATH: process.env["PATH"] ?? "",
    AIO_OFFICE_DB: config.dbPath,
    AIO_OFFICE_PASSWORT_DATEI: config.passwordFile,
    AIO_OFFICE_VERFASSUNG: config.constitutionPath,
    AIO_SUPERVISOR_SOCKET: config.socketPath,
    AIO_OFFICE_HOST: config.webHost,
    AIO_OFFICE_GATEWAY_PORT: "0",
    AIO_OFFICE_API_PORT: "0",
    AIO_OFFICE_KONSOLE: "",
  });

  function run(args: string[], extraEnv: Record<string, string> = {}, input?: string) {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env: { ...env(), ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.stdin.end(input ?? "");
    const exit = new Promise<number | null>((resolve) => child.on("exit", resolve));
    return { child, exit, out: () => stdout, err: () => stderr };
  }

  it("startet, meldet sich im Protokoll und endet auf SIGTERM mit 0", async () => {
    await supervisor();
    const proc = run([]);
    await until(() => proc.out().includes('"msg":"Office gestartet"'), "Start", 15_000);
    proc.child.kill("SIGTERM");
    expect(await proc.exit).toBe(0);
    expect(proc.out()).toContain('"msg":"Office beendet"');
    for (const line of proc.out().trim().split("\n")) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  }, 20_000);

  it("lehnt falsche Aufrufe und Einstellungen mit eigenen Exit-Codes ab", async () => {
    const usage = run(["unbekannt"]);
    expect(await usage.exit).toBe(64);
    expect(usage.err()).toContain("Aufruf: main.ts [passwort]");
    const bad = run([], { AIO_OFFICE_GATEWAY_PORT: "x" });
    expect(await bad.exit).toBe(78);
    expect(bad.err()).toContain("AIO_OFFICE_GATEWAY_PORT");
    rmSync(config.constitutionPath);
    const noConstitution = run([]);
    expect(await noConstitution.exit).toBe(1);
    expect(noConstitution.err()).toContain("Office nicht gestartet");
  }, 20_000);

  it("setzt mit passwort den Hash aus stdin", async () => {
    // Mit den Standardwerten von scrypt (128 MiB), wie im Betrieb.
    const proc = run(["passwort"], {}, "ein langes Passwort\n");
    expect(await proc.exit).toBe(0);
    expect(proc.err()).toContain("Passwort gespeichert");
    const stored = readPasswordFile(config.passwordFile) as string;
    expect(stored.startsWith("scrypt$131072$8$1$")).toBe(true);
  }, 20_000);
});
