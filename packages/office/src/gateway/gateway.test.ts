import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CEO_ID } from "../domain/agent.ts";
import { buildContext } from "../domain/context.ts";
import { Office } from "../domain/office.ts";
import { loadStartBooks, loadStartPersonas } from "../domain/start-content.ts";
import { loadStartData, seedStartAgents } from "../domain/start-data.ts";
import { EventStore } from "../events/event-store.ts";
import type { IpcParams, IpcResult } from "../ipc/protocol.ts";
import { Planner, type RunRequester } from "../planner/planner.ts";
import {
  DEFAULT_LOGIN_THROTTLE,
  MAX_SOCKETS_PER_SESSION,
  OfficeGateway,
  type GatewayOptions,
} from "./gateway.ts";
import { hashPassword } from "./password.ts";
import { SESSION_COOKIE, Sessions } from "./sessions.ts";
import { acceptKey } from "./websocket.ts";

const HOST = "office.aio.internal";
const ORIGIN = `https://${HOST}`;
const PASSWORT = "richtig-langes-passwort";
const COO = "deniz-kaya";
const CTO = "jonas-albrecht";
/** Schnelle scrypt-Parameter nur für Tests. */
const FAST = { N: 2 ** 10, r: 8, p: 1 };

let dir: string;
let store: EventStore;
let office: Office;
let stored: string | null;
let server: Server;
let port: number;
let gateway: OfficeGateway;
let clock: number;
let ceoMessages: string[];
let viaCoo: boolean;

const fastHash = hashPassword(PASSWORT, FAST);

function setup(options: Partial<GatewayOptions> = {}): void {
  gateway = new OfficeGateway({
    office,
    store,
    host: HOST,
    passwordHash: () => stored,
    sessions: new Sessions({}, () => clock),
    now: () => clock,
    onCeoMessage: (message) => ceoMessages.push(message.id),
    ceoViaCooOnly: () => viaCoo,
    log: () => undefined,
    ...options,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aio-gateway-"));
  const start = loadStartData();
  store = EventStore.open(join(dir, "office.db"));
  office = Office.open(store, start.building, { now: () => new Date("2026-11-05T09:00:00Z") });
  seedStartAgents(office, start.agents);
  stored = await fastHash;
  clock = Date.parse("2026-11-05T09:00:00Z");
  ceoMessages = [];
  viaCoo = false;
  setup();
  // Der Server reicht an das aktuelle `gateway` weiter; Tests können es austauschen.
  server = createServer((req, res) => {
    gateway.handle(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    gateway.upgrade(req, socket, head);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  gateway.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Response {
  status: number;
  headers: IncomingHttpHeaders;
  json: Record<string, unknown>;
}

interface CallOptions {
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
  /** Ohne `Origin` (Standard: mit, bei POST). */
  noOrigin?: boolean;
}

function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const body =
    options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const headers: Record<string, string> = {
    host: HOST,
    ...(method === "POST" && options.noOrigin !== true ? { origin: ORIGIN } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...options.headers,
  };
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
        });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function connections(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.getConnections((error, n) => {
      if (error) {
        reject(error);
      } else {
        resolve(n);
      }
    });
  });
}

/**
 * Wartet höchstens 2 s, bis der Server nicht mehr TCP-Verbindungen hat als `limit`. Gibt die
 * Zahl zurück. Verbindungen aus `call()` bleiben per Keep-Alive offen und zählen mit.
 */
async function connectionsDrop(limit: number): Promise<number> {
  let count = Infinity;
  for (let i = 0; i < 100; i++) {
    count = await connections();
    if (count <= limit) {
      return count;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return count;
}

interface Login {
  cookie: string;
  csrf: string;
}

async function login(): Promise<Login> {
  const res = await call("POST", "/api/login", { body: { password: PASSWORT } });
  expect(res.status).toBe(200);
  const setCookie = (res.headers["set-cookie"] ?? [])[0] ?? "";
  return { cookie: setCookie.split(";")[0] as string, csrf: res.json["csrfToken"] as string };
}

function authed(auth: Login, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: auth.cookie, "x-csrf-token": auth.csrf, ...extra };
}

describe("Anmeldung", () => {
  it("setzt ein __Host-Cookie mit Secure, HttpOnly und SameSite=Strict", async () => {
    const res = await call("POST", "/api/login", { body: { password: PASSWORT } });
    expect(res.status).toBe(200);
    const cookie = (res.headers["set-cookie"] ?? [])[0] ?? "";
    const parts = cookie.split("; ");
    expect(parts[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}$`));
    expect(parts).toEqual(
      expect.arrayContaining(["Path=/", "Secure", "HttpOnly", "SameSite=Strict", "Max-Age=86400"]),
    );
    // `__Host-` verlangt: kein Domain-Attribut.
    expect(cookie.toLowerCase()).not.toContain("domain=");
    expect(res.json["csrfToken"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("lehnt ein falsches Passwort ab und meldet den Zustand der Sitzung", async () => {
    expect((await call("POST", "/api/login", { body: { password: "falsch-falsch" } })).status).toBe(
      401,
    );
    expect((await call("GET", "/api/session")).json).toEqual({ authenticated: false });
    const auth = await login();
    const session = await call("GET", "/api/session", { headers: { cookie: auth.cookie } });
    expect(session.json).toEqual({ authenticated: true, csrfToken: auth.csrf });
  });

  it("verlangt Origin, JSON und genau das Feld password", async () => {
    const body = { password: PASSWORT };
    expect((await call("POST", "/api/login", { body, noOrigin: true })).status).toBe(403);
    expect(
      (await call("POST", "/api/login", { body, headers: { origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
    // Ein Formular eines fremden Origins könnte nur text/plain oder urlencoded senden.
    expect(
      (await call("POST", "/api/login", { body, headers: { "content-type": "text/plain" } }))
        .status,
    ).toBe(415);
    expect(
      (await call("POST", "/api/login", { body: { password: PASSWORT, extra: 1 } })).status,
    ).toBe(400);
    expect((await call("POST", "/api/login", { raw: "{kein json" })).status).toBe(400);
  });

  it("sperrt nach zu vielen Fehlversuchen, auch für das richtige Passwort", async () => {
    for (let i = 0; i < DEFAULT_LOGIN_THROTTLE.maxFailures; i++) {
      expect(
        (await call("POST", "/api/login", { body: { password: `falsch-${String(i)}-xxxxx` } }))
          .status,
      ).toBe(401);
    }
    const locked = await call("POST", "/api/login", { body: { password: PASSWORT } });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    clock += DEFAULT_LOGIN_THROTTLE.windowMs;
    expect((await call("POST", "/api/login", { body: { password: PASSWORT } })).status).toBe(200);
  });

  it("ohne eingerichtetes Passwort ist keine Anmeldung möglich", async () => {
    stored = null;
    expect((await call("POST", "/api/login", { body: { password: PASSWORT } })).status).toBe(503);
  });

  it("gibt bei jeder Anmeldung eine neue Sitzung und beendet die alte", async () => {
    const first = await login();
    const res = await call("POST", "/api/login", {
      body: { password: PASSWORT },
      headers: { cookie: first.cookie },
    });
    expect(res.status).toBe(200);
    const second = ((res.headers["set-cookie"] ?? [])[0] ?? "").split(";")[0];
    expect(second).not.toBe(first.cookie);
    expect((await call("GET", "/api/state", { headers: { cookie: first.cookie } })).status).toBe(
      401,
    );
  });

  it("Abmelden beendet die Sitzung und löscht das Cookie", async () => {
    const auth = await login();
    const res = await call("POST", "/api/logout", { body: {}, headers: authed(auth) });
    expect(res.status).toBe(204);
    expect((res.headers["set-cookie"] ?? [])[0]).toContain("Max-Age=0");
    expect((await call("GET", "/api/state", { headers: { cookie: auth.cookie } })).status).toBe(
      401,
    );
  });

  it("Sitzungen laufen nach Leerlauf und nach der Höchstdauer ab", async () => {
    const auth = await login();
    clock += 7 * 3_600_000;
    expect((await call("GET", "/api/state", { headers: { cookie: auth.cookie } })).status).toBe(
      200,
    );
    clock += 7 * 3_600_000;
    expect((await call("GET", "/api/state", { headers: { cookie: auth.cookie } })).status).toBe(
      200,
    );
    // 14 h nach der Anmeldung, aktiv genutzt: Leerlauf nie über 8 h, aber die 24 h kommen.
    clock += 7 * 3_600_000;
    expect((await call("GET", "/api/state", { headers: { cookie: auth.cookie } })).status).toBe(
      200,
    );
    clock += 4 * 3_600_000;
    expect((await call("GET", "/api/state", { headers: { cookie: auth.cookie } })).status).toBe(
      401,
    );
    const idle = await login();
    clock += 8 * 3_600_000;
    expect((await call("GET", "/api/state", { headers: { cookie: idle.cookie } })).status).toBe(
      401,
    );
  });

  it("ein doppeltes Sitzungscookie gilt nicht", async () => {
    const auth = await login();
    const forged = `${SESSION_COOKIE}=${"A".repeat(43)}`;
    // Beide Reihenfolgen: Weder das erste noch das letzte Vorkommen darf gelten.
    for (const cookie of [`${forged}; ${auth.cookie}`, `${auth.cookie}; ${forged}`]) {
      const res = await call("GET", "/api/state", { headers: { cookie } });
      expect(res.status).toBe(401);
    }
    expect((await call("GET", "/api/state", { headers: { cookie: auth.cookie } })).status).toBe(
      200,
    );
  });
});

describe("Anfragen", () => {
  it("prüft den Hostnamen (gegen DNS-Rebinding)", async () => {
    expect((await call("GET", "/api/session", { headers: { host: "127.0.0.1" } })).status).toBe(
      421,
    );
    expect((await call("GET", "/api/session", { headers: { host: "evil.example" } })).status).toBe(
      421,
    );
  });

  it("lesende Anfragen nur ohne fremde Herkunft", async () => {
    const auth = await login();
    const cookie = { cookie: auth.cookie };
    expect(
      (await call("GET", "/api/state", { headers: { ...cookie, "sec-fetch-site": "same-origin" } }))
        .status,
    ).toBe(200);
    for (const site of ["cross-site", "same-site"]) {
      const res = await call("GET", "/api/state", {
        headers: { ...cookie, "sec-fetch-site": site },
      });
      expect([site, res.status]).toEqual([site, 403]);
    }
    expect(
      (await call("GET", "/api/state", { headers: { ...cookie, origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
  });

  it("ohne Anmeldung nur Sitzung und Anmeldung", async () => {
    for (const path of ["/api/state", "/api/timeline", "/api/chat"]) {
      expect([path, (await call("GET", path)).status]).toEqual([path, 401]);
    }
    expect((await call("POST", "/api/chat", { body: { text: "x" } })).status).toBe(401);
  });

  it("antwortet 404 und 405 mit Allow", async () => {
    expect((await call("GET", "/")).status).toBe(404);
    expect((await call("GET", "/api/gibt-es-nicht")).status).toBe(404);
    const res = await call("DELETE", "/api/chat");
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET, POST");
    expect((await call("GET", "/api/login")).headers["allow"]).toBe("POST");
  });

  it("liefert Agenten, offene Aufgaben und Kosten", async () => {
    const auth = await login();
    const res = await call("GET", "/api/state", { headers: { cookie: auth.cookie } });
    expect(res.status).toBe(200);
    const agents = res.json["agents"] as { id: string; running: boolean; costUsd: number }[];
    expect(agents.map((a) => a.id)).toContain(COO);
    expect(agents.every((a) => !a.running && a.costUsd === 0)).toBe(true);
    expect(res.json["cooId"]).toBe(COO);
    expect(res.json["costs"]).toEqual({ totalUsd: 0 });
    expect(res.json["lastSeq"]).toBe(office.state.lastSeq);
  });

  it("ein Lauf ohne Ende gilt wie im Planer nach 120 Minuten als verloren", async () => {
    const auth = await login();
    const trigger = office.sendMessage(CEO_ID, { toId: COO, kind: "auftrag", text: "los" });
    office.recordRunStarted(
      {
        agentId: COO,
        taskId: null,
        runType: "buero",
        model: "sonnet",
        inboxUpToSeq: 0,
        triggerIds: [trigger.id],
      },
      { runId: "run-1" },
    );
    const running = async (): Promise<boolean | undefined> => {
      const res = await call("GET", "/api/state", { headers: { cookie: auth.cookie } });
      return (res.json["agents"] as { id: string; running: boolean }[]).find((a) => a.id === COO)
        ?.running;
    };
    expect(await running()).toBe(true);
    clock += 119 * 60_000;
    expect(await running()).toBe(true);
    clock += 2 * 60_000;
    expect(await running()).toBe(false);
  });

  it("lastSeq der Zeitleiste liegt nie hinter ihren Ereignissen", async () => {
    const auth = await login();
    // Ein zweiter Schreiber auf derselben Datei; `office` hat das noch nicht gelesen.
    const other = Office.open(store, loadStartData().building, {
      now: () => new Date("2026-11-05T09:00:00Z"),
    });
    other.sendMessage(CEO_ID, { toId: COO, kind: "info", text: "von außen" });
    const res = await call("GET", "/api/timeline?limit=500", { headers: { cookie: auth.cookie } });
    const events = res.json["events"] as { seq: number }[];
    expect(res.json["lastSeq"]).toBe(events.at(-1)?.seq);
  });

  it("Zeitleiste mit after und limit", async () => {
    const auth = await login();
    const all = await call("GET", "/api/timeline?limit=500", { headers: { cookie: auth.cookie } });
    const events = all.json["events"] as { seq: number; type: string; actor: string }[];
    expect(events.length).toBe(office.state.lastSeq);
    expect(events[0]).toMatchObject({ seq: 1, type: "agent.hired" });
    const page = await call("GET", "/api/timeline?after=2&limit=1", {
      headers: { cookie: auth.cookie },
    });
    expect((page.json["events"] as { seq: number }[]).map((e) => e.seq)).toEqual([3]);
    expect(
      (await call("GET", "/api/timeline?after=-1", { headers: { cookie: auth.cookie } })).status,
    ).toBe(400);
  });
});

describe("CEO-Chat", () => {
  it("speichert nichts, wenn die Sitzung endet, während der Körper noch ankommt", async () => {
    const auth = await login();
    const body = JSON.stringify({ text: "zu spät" });
    const half = Math.floor(body.length / 2);
    const done = new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/chat",
          headers: {
            host: HOST,
            origin: ORIGIN,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
            ...authed(auth),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.write(body.slice(0, half));
      setTimeout(() => {
        void call("POST", "/api/logout", { body: {}, headers: authed(auth) }).then(() => {
          req.end(body.slice(half));
        });
      }, 20);
    });
    expect(await done).toBe(401);
    expect(ceoMessages).toEqual([]);
    expect(office.state.messages().some((m) => m.text === "zu spät")).toBe(false);
  });

  it("braucht das CSRF-Token der Sitzung und den eigenen Origin", async () => {
    const auth = await login();
    const body = { text: "Hallo" };
    expect(
      (await call("POST", "/api/chat", { body, headers: { cookie: auth.cookie } })).status,
    ).toBe(403);
    expect(
      (
        await call("POST", "/api/chat", {
          body,
          headers: { cookie: auth.cookie, "x-csrf-token": "A".repeat(43) },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call("POST", "/api/chat", { body, headers: authed(auth), noOrigin: true })).status,
    ).toBe(403);
    // Das Token einer anderen Sitzung passt nicht.
    const other = await call("POST", "/api/login", { body: { password: PASSWORT } });
    expect(
      (
        await call("POST", "/api/chat", {
          body,
          headers: { cookie: auth.cookie, "x-csrf-token": other.json["csrfToken"] as string },
        })
      ).status,
    ).toBe(403);
    expect(ceoMessages).toEqual([]);
  });

  it("ohne Empfänger geht die Nachricht als Auftrag an den COO", async () => {
    const auth = await login();
    const res = await call("POST", "/api/chat", {
      body: { text: "Bitte einen Plan für Q1" },
      headers: authed(auth),
    });
    expect(res.status).toBe(201);
    const message = res.json["message"] as {
      id: string;
      fromId: string;
      toId: string;
      kind: string;
    };
    expect(message).toMatchObject({ fromId: "ceo", toId: COO, kind: "auftrag" });
    expect(ceoMessages).toEqual([message.id]);
    const list = await call("GET", `/api/chat?with=${COO}`, { headers: { cookie: auth.cookie } });
    expect((list.json["messages"] as { id: string }[]).map((m) => m.id)).toEqual([message.id]);
    const other = await call("GET", `/api/chat?with=${CTO}`, { headers: { cookie: auth.cookie } });
    expect(other.json["messages"]).toEqual([]);
  });

  it("speichert Agententext unverändert, auch mit HTML (AK 9: Darstellung nur als Text in P10)", async () => {
    const auth = await login();
    const text = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const res = await call("POST", "/api/chat", { body: { to: CTO, text }, headers: authed(auth) });
    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect((res.json["message"] as { text: string }).text).toBe(text);
  });

  it("prüft Empfänger, Art und Felder", async () => {
    const auth = await login();
    const send = (body: unknown) => call("POST", "/api/chat", { body, headers: authed(auth) });
    expect((await send({ to: "niemand", text: "x" })).status).toBe(422);
    expect((await send({ to: "ceo", text: "x" })).status).toBe(422);
    expect((await send({ to: CTO, kind: "befehl", text: "x" })).status).toBe(422);
    expect((await send({ to: CTO })).status).toBe(422);
    expect((await send({ to: CTO, text: "x", admin: true })).status).toBe(400);
    expect((await send({ to: CTO, text: "x".repeat(20_001) })).status).toBe(422);
    expect((await send({ to: CTO, text: "x", clientId: "kurz" })).status).toBe(422);
    expect(ceoMessages).toEqual([]);
  });

  it("mit der Weisung aus E46 nur an den COO", async () => {
    viaCoo = true;
    const auth = await login();
    const send = (body: unknown) => call("POST", "/api/chat", { body, headers: authed(auth) });
    expect((await send({ to: CTO, text: "x" })).status).toBe(422);
    expect((await send({ to: COO, text: "x" })).status).toBe(201);
  });

  it("eine wiederholte Nachricht mit derselben clientId entsteht nur einmal", async () => {
    const auth = await login();
    const body = { to: CTO, kind: "frage", text: "Wie weit ist P10?", clientId: "abc123-xyz" };
    const first = await call("POST", "/api/chat", { body, headers: authed(auth) });
    const before = office.state.lastSeq;
    const second = await call("POST", "/api/chat", { body, headers: authed(auth) });
    expect(second.status).toBe(201);
    expect((second.json["message"] as { id: string }).id).toBe(
      (first.json["message"] as { id: string }).id,
    );
    expect(office.state.lastSeq).toBe(before);
    // Derselbe Schlüssel mit anderem Inhalt ist ein Fehler, keine zweite Nachricht.
    const changed = await call("POST", "/api/chat", {
      body: { ...body, text: "Anders" },
      headers: authed(auth),
    });
    expect(changed.status).toBe(422);
  });

  it("weckt über den Planer einen Lauf beim Empfänger", async () => {
    const requests: IpcParams<"run.request">[] = [];
    const requester: RunRequester = {
      requestRun(params): Promise<IpcResult<"run.request">> {
        requests.push(params);
        return Promise.resolve({ decision: "admitted", runId: `run-${String(requests.length)}` });
      },
    };
    const books = loadStartBooks();
    const personas = loadStartPersonas();
    const planner = new Planner({
      office,
      requester,
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
    const ticks: Promise<unknown>[] = [];
    setup({ onCeoMessage: () => ticks.push(planner.tick()) });
    const auth = await login();
    expect(
      (
        await call("POST", "/api/chat", {
          body: { text: "Info", kind: "info" },
          headers: authed(auth),
        })
      ).status,
    ).toBe(201);
    await Promise.all(ticks);
    // `info` weckt niemanden (E32).
    expect(requests).toEqual([]);
    expect(
      (
        await call("POST", "/api/chat", {
          body: { text: "Bitte übernehmen" },
          headers: authed(auth),
        })
      ).status,
    ).toBe(201);
    await Promise.all(ticks);
    expect(requests.map((r) => r.agentId)).toEqual([COO]);
    expect(requests[0]?.prompt).toContain("Bitte übernehmen");
  });
});

/** Minimaler WebSocket-Client auf TCP, um Handshake und Rahmen genau zu prüfen. */
class RawClient {
  readonly socket: Socket;
  private data = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  ended = false;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.data = Buffer.concat([this.data, chunk]);
      this.wake();
    });
    socket.on("close", () => {
      this.ended = true;
      this.wake();
    });
    socket.on("error", () => undefined);
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter();
    }
  }

  private async until(check: () => boolean): Promise<void> {
    while (!check()) {
      if (this.ended) {
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** `halfOpen`: Der Client schickt kein FIN, wenn der Server seine Seite schließt. */
  static async open(
    headers: Record<string, string>,
    path = "/api/live",
    halfOpen = false,
  ): Promise<RawClient> {
    const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: halfOpen });
    await new Promise((resolve) => socket.once("connect", resolve));
    const lines = [
      `GET ${path} HTTP/1.1`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ];
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    return new RawClient(socket);
  }

  /** Statuszeile und Header der Antwort. */
  async response(): Promise<{ status: number; headers: Map<string, string> }> {
    await this.until(() => this.data.includes("\r\n\r\n"));
    const end = this.data.indexOf("\r\n\r\n");
    const lines = this.data.subarray(0, end).toString("latin1").split("\r\n");
    this.data = this.data.subarray(end + 4);
    const status = Number((lines[0] ?? "").split(" ")[1]);
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
    }
    return { status, headers };
  }

  /** Nächster Rahmen des Servers. */
  async frame(): Promise<{ opcode: number; payload: Buffer; masked: boolean } | null> {
    await this.until(() => this.data.length >= 2 && this.data.length >= this.frameLength());
    if (this.data.length < 2 || this.data.length < this.frameLength()) {
      return null;
    }
    const total = this.frameLength();
    const first = this.data[0] as number;
    const second = this.data[1] as number;
    const len7 = second & 0x7f;
    const offset = len7 === 126 ? 4 : len7 === 127 ? 10 : 2;
    const frame = {
      opcode: first & 0x0f,
      masked: (second & 0x80) !== 0,
      payload: Buffer.from(this.data.subarray(offset, total)),
    };
    this.data = this.data.subarray(total);
    return frame;
  }

  private frameLength(): number {
    const len7 = (this.data[1] as number) & 0x7f;
    if (len7 === 126) {
      return this.data.length < 4 ? Infinity : 4 + this.data.readUInt16BE(2);
    }
    if (len7 === 127) {
      return this.data.length < 10 ? Infinity : 10 + Number(this.data.readBigUInt64BE(2));
    }
    return 2 + len7;
  }

  /** Sendet einen Rahmen; `mask: false` für Protokollverstöße. */
  send(
    opcode: number,
    payload: Buffer,
    options: { mask?: boolean; fin?: boolean; rsv?: number } = {},
  ): void {
    const mask = options.mask ?? true;
    const head = Buffer.from([
      ((options.fin ?? true) ? 0x80 : 0) | ((options.rsv ?? 0) << 4) | opcode,
      (mask ? 0x80 : 0) | payload.length,
    ]);
    if (!mask) {
      this.socket.write(Buffer.concat([head, payload]));
      return;
    }
    const key = Buffer.from([1, 2, 3, 4]);
    const body = Buffer.from(payload.map((b, i) => b ^ (key[i % 4] as number)));
    this.socket.write(Buffer.concat([head, key, body]));
  }

  async closed(): Promise<void> {
    await this.until(() => false);
  }
}

// Beispiel aus RFC 6455 Abschnitt 1.3: Base64 von „the sample nonce“ (16 Byte).
const WS_KEY = Buffer.from("the sample nonce").toString("base64");

function wsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: HOST,
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-version": "13",
    "sec-websocket-key": WS_KEY,
    origin: ORIGIN,
    ...extra,
  };
}

describe("WebSocket", () => {
  it("Handshake nach RFC 6455, dann Hinweis auf den Stand und neue Ereignisse", async () => {
    // Beispiel aus RFC 6455 Abschnitt 1.3.
    expect(acceptKey(WS_KEY)).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    const auth = await login();
    const client = await RawClient.open(wsHeaders({ cookie: auth.cookie }));
    const res = await client.response();
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-accept")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    const hello = await client.frame();
    expect(hello?.masked).toBe(false);
    expect(hello?.opcode).toBe(0x1);
    expect(JSON.parse(hello?.payload.toString() ?? "")).toEqual({
      type: "events",
      lastSeq: office.state.lastSeq,
    });
    // Eine neue Nachricht meldet das Gateway sofort.
    await call("POST", "/api/chat", { body: { to: CTO, text: "Hallo" }, headers: authed(auth) });
    const next = await client.frame();
    expect(JSON.parse(next?.payload.toString() ?? "")).toEqual({
      type: "events",
      lastSeq: office.state.lastSeq,
    });
    // Ereignisse aus anderen Teilen des Office (Planer, Office-API) findet `poll`.
    office.sendMessage(CTO, { toId: "ceo", kind: "info", text: "Erledigt" });
    gateway.poll();
    const third = await client.frame();
    expect(JSON.parse(third?.payload.toString() ?? "")).toMatchObject({
      lastSeq: office.state.lastSeq,
    });
    client.socket.destroy();
  });

  it("lehnt fremde Herkunft, fehlende Sitzung und falsche Handshakes ab", async () => {
    const auth = await login();
    const cases: [string, Record<string, string>, number][] = [
      ["ohne Cookie", wsHeaders(), 401],
      ["fremder Origin", wsHeaders({ cookie: auth.cookie, origin: "https://evil.example" }), 403],
      ["ohne Origin", { ...wsHeaders({ cookie: auth.cookie }), origin: "" }, 403],
      ["falscher Host", wsHeaders({ cookie: auth.cookie, host: "127.0.0.1" }), 421],
      ["Version 8", wsHeaders({ cookie: auth.cookie, "sec-websocket-version": "8" }), 426],
      ["kurzer Schlüssel", wsHeaders({ cookie: auth.cookie, "sec-websocket-key": "abc" }), 400],
    ];
    for (const [name, headers, status] of cases) {
      const client = await RawClient.open(headers);
      const res = await client.response();
      expect([name, res.status]).toEqual([name, status]);
      client.socket.destroy();
    }
    const wrongPath = await RawClient.open(wsHeaders({ cookie: auth.cookie }), "/api/state");
    expect((await wrongPath.response()).status).toBe(404);
    wrongPath.socket.destroy();
  });

  it("beantwortet Ping, schließt bei Daten vom Browser und bei Protokollfehlern", async () => {
    const auth = await login();
    const open = async (): Promise<RawClient> => {
      const client = await RawClient.open(wsHeaders({ cookie: auth.cookie }));
      expect((await client.response()).status).toBe(101);
      await client.frame();
      return client;
    };
    const ping = await open();
    ping.send(0x9, Buffer.from("hallo"));
    const pong = await ping.frame();
    expect(pong?.opcode).toBe(0xa);
    expect(pong?.payload.toString()).toBe("hallo");
    ping.send(0x8, Buffer.from([0x03, 0xe8]));
    const ack = await ping.frame();
    expect(ack?.opcode).toBe(0x8);
    await ping.closed();

    const cases: [string, (c: RawClient) => void, number][] = [
      [
        "Textrahmen",
        (c) => {
          c.send(0x1, Buffer.from("x"));
        },
        1003,
      ],
      [
        "unmaskiert",
        (c) => {
          c.send(0x9, Buffer.alloc(0), { mask: false });
        },
        1002,
      ],
      [
        "RSV gesetzt",
        (c) => {
          c.send(0x9, Buffer.alloc(0), { rsv: 4 });
        },
        1002,
      ],
      [
        "fragmentierter Ping",
        (c) => {
          c.send(0x9, Buffer.alloc(0), { fin: false });
        },
        1002,
      ],
      [
        "unbekannter Opcode",
        (c) => {
          c.send(0x3, Buffer.alloc(0));
        },
        1002,
      ],
      [
        "Close mit einem Byte",
        (c) => {
          c.send(0x8, Buffer.from([0x03]));
        },
        1002,
      ],
      [
        "Close mit 1005",
        (c) => {
          c.send(0x8, Buffer.from([0x03, 0xed]));
        },
        1002,
      ],
      [
        "Close mit 999",
        (c) => {
          c.send(0x8, Buffer.from([0x03, 0xe7]));
        },
        1002,
      ],
      [
        "Close mit 2000",
        (c) => {
          c.send(0x8, Buffer.from([0x07, 0xd0]));
        },
        1002,
      ],
      [
        "Close mit ungültigem UTF-8",
        (c) => {
          c.send(0x8, Buffer.from([0x03, 0xe8, 0xff]));
        },
        1007,
      ],
      [
        "Close mit 4000 und Text",
        (c) => {
          c.send(0x8, Buffer.concat([Buffer.from([0x0f, 0xa0]), Buffer.from("tschüss")]));
        },
        1000,
      ],
    ];
    for (const [name, act, code] of cases) {
      const client = await open();
      act(client);
      const close = await client.frame();
      expect([name, close?.opcode, close?.payload.readUInt16BE(0)]).toEqual([name, 0x8, code]);
      await client.closed();
    }
  });

  it("endet mit der Sitzung und begrenzt Verbindungen je Sitzung", async () => {
    const auth = await login();
    const clients: RawClient[] = [];
    for (let i = 0; i < MAX_SOCKETS_PER_SESSION; i++) {
      const client = await RawClient.open(wsHeaders({ cookie: auth.cookie }));
      expect((await client.response()).status).toBe(101);
      await client.frame();
      clients.push(client);
    }
    const extra = await RawClient.open(wsHeaders({ cookie: auth.cookie }));
    expect((await extra.response()).status).toBe(429);
    extra.socket.destroy();
    expect(gateway.liveConnections).toBe(MAX_SOCKETS_PER_SESSION);
    await call("POST", "/api/logout", { body: {}, headers: authed(auth) });
    for (const client of clients) {
      const close = await client.frame();
      expect([close?.opcode, close?.payload.readUInt16BE(0)]).toEqual([0x8, 1008]);
      await client.closed();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.liveConnections).toBe(0);
  });

  it("trennt nach Ablauf der Sitzung beim nächsten Durchlauf", async () => {
    const auth = await login();
    const client = await RawClient.open(wsHeaders({ cookie: auth.cookie }));
    expect((await client.response()).status).toBe(101);
    await client.frame();
    clock += 8 * 3_600_000;
    gateway.poll();
    const close = await client.frame();
    expect(close?.payload.readUInt16BE(0)).toBe(1008);
    await client.closed();
  });

  it("schließt abgelehnte Upgrades auch ohne FIN des Clients", async () => {
    const before = await connections();
    const client = await RawClient.open(wsHeaders(), "/api/live", true);
    expect((await client.response()).status).toBe(401);
    expect(await connectionsDrop(before)).toBeLessThanOrEqual(before);
  });

  it("trennt nach einem Close, wenn der Client kein FIN schickt", async () => {
    setup({ websocket: { heartbeatMs: 30 } });
    const auth = await login();
    const before = await connections();
    const client = await RawClient.open(wsHeaders({ cookie: auth.cookie }), "/api/live", true);
    expect((await client.response()).status).toBe(101);
    await client.frame();
    client.send(0x8, Buffer.from([0x03, 0xe8]));
    expect((await client.frame())?.opcode).toBe(0x8);
    expect(await connectionsDrop(before)).toBeLessThanOrEqual(before);
    expect(gateway.liveConnections).toBe(0);
  });

  it("trennt, wenn sich Pongs anstauen, weil der Client nicht liest", async () => {
    setup({ websocket: { maxBufferedBytes: 64 * 1024 } });
    const auth = await login();
    const before = await connections();
    const client = await RawClient.open(wsHeaders({ cookie: auth.cookie }));
    expect((await client.response()).status).toBe(101);
    await client.frame();
    client.socket.pause();
    // 125 Byte je Ping, zusammen weit mehr, als die Puffer des Kernels fassen.
    const ping = Buffer.alloc(125, 0x61);
    for (let i = 0; i < 400; i++) {
      for (let j = 0; j < 200; j++) {
        client.send(0x9, ping);
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (gateway.liveConnections === 0) {
        break;
      }
    }
    expect(await connectionsDrop(before)).toBeLessThanOrEqual(before);
    expect(gateway.liveConnections).toBe(0);
  });

  it("trennt einen Browser, der auf Pings nicht antwortet", async () => {
    setup({ websocket: { heartbeatMs: 30 } });
    const auth = await login();
    const client = await RawClient.open(wsHeaders({ cookie: auth.cookie }));
    expect((await client.response()).status).toBe(101);
    await client.frame();
    const ping = await client.frame();
    expect(ping?.opcode).toBe(0x9);
    // Kein Pong: Beim nächsten Takt trennt der Server ohne Close-Rahmen.
    await client.closed();
    expect(client.ended).toBe(true);
  });

  it("funktioniert mit dem WebSocket-Client von Node (undici)", async () => {
    // Nodes Client setzt `Host` selbst; dafür ein Gateway mit diesem Host.
    setup({ host: `127.0.0.1:${String(port)}` });
    const res = await call("POST", "/api/login", {
      body: { password: PASSWORT },
      headers: { host: `127.0.0.1:${String(port)}`, origin: `https://127.0.0.1:${String(port)}` },
    });
    const cookie = ((res.headers["set-cookie"] ?? [])[0] ?? "").split(";")[0] as string;
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/live`, {
      headers: { origin: `https://127.0.0.1:${String(port)}`, cookie },
    });
    const message = await new Promise<string>((resolve, reject) => {
      ws.onmessage = (event) => {
        resolve(String(event.data));
      };
      ws.onerror = () => {
        reject(new Error("WebSocket-Fehler"));
      };
    });
    expect(JSON.parse(message)).toEqual({ type: "events", lastSeq: office.state.lastSeq });
    const closed = new Promise<number>((resolve) => {
      ws.onclose = (event) => {
        resolve(event.code);
      };
    });
    ws.close(1000);
    expect(await closed).toBe(1000);
  });
});
