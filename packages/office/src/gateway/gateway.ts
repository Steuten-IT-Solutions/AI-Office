import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { CEO_ID } from "../domain/agent.ts";
import { findRoom } from "../domain/building.ts";
import { MESSAGE_KINDS, type Message, type MessageKind } from "../domain/message.ts";
import { MAX_DIRECTIVE_CHARS, MAX_DIRECTIVE_CHARS_PER_AGENT } from "../domain/events.ts";
import { DomainError, type Office } from "../domain/office.ts";
import type { Directive } from "../domain/office-state.ts";
import { CLOSED_STATUSES } from "../domain/task.ts";
import { ValidationError, isRecord } from "../domain/validation.ts";
import type { JsonValue } from "../events/canonical-json.ts";
import type { EventStore } from "../events/event-store.ts";
import { DEFAULT_PLANNER_CONFIG, activeRun, type PlannerConfig } from "../planner/planner.ts";
import { verifyPassword } from "./password.ts";
import { StaticFiles, WEB_HEADERS } from "./static-files.ts";
import {
  checkConsoleUrl,
  pullRequestListSchema,
  quotaViewSchema,
  type PullRequestView,
  type QuotaView,
} from "./views.ts";
import {
  Sessions,
  clearedSessionCookie,
  safeEqual,
  sessionCookie,
  sessionIdFromCookie,
  type Session,
} from "./sessions.ts";
import {
  CLOSE_CODES,
  WebSocketPeer,
  checkHandshake,
  refuseUpgrade,
  type WebSocketOptions,
} from "./websocket.ts";

/**
 * Office-Gateway (P09, plan.md Kap. 3.2, 4.7, 5.11): HTTP-API und Live-Updates für das
 * Webinterface, Anmeldung des CEO, CEO-Chat. **Keine** Freigaben, **kein** Notaus (E26).
 *
 * Das Gateway lauscht nur auf Loopback. Davor steht der Reverse-Proxy des Supervisors (S13): Er
 * beendet TLS unter `office.aio.internal`, prüft den Hostnamen, setzt die Sicherheits-Header und
 * reicht WebSockets durch. Die Prüfungen hier gelten trotzdem, denn auf Loopback erreicht das
 * Gateway jeder Prozess des Rechners:
 * - `Host` muss der Name des Webinterface sein (gegen DNS-Rebinding).
 * - Zustandsändernde Anfragen nur per POST mit `Content-Type: application/json`, exakt
 *   passendem `Origin` und dem CSRF-Token der Sitzung im Header `X-CSRF-Token` (Kap. 5.11).
 * - Lesende Anfragen weist das Gateway ab, wenn `Sec-Fetch-Site` eine fremde Herkunft meldet.
 * - WebSockets nur mit passendem `Origin` und gültiger Sitzung. Endet die Sitzung, endet auch die
 *   Verbindung.
 * - Keine CORS-Header.
 *
 * Über den WebSocket gehen nur Hinweise „es gibt neue Ereignisse bis Sequenz N“. Die Daten holt
 * das Webinterface über HTTP; so gilt für beide Wege dieselbe Prüfung.
 *
 * Das Gateway liefert auch das von Vite gebaute Webinterface aus (P10, `static-files.ts`): nur
 * Dateien aus `web/dist/`, eigene CSP, keine Inline-Skripte.
 *
 * Eine Nachricht des CEO schreibt das Gateway ins Ereignisprotokoll und ruft `onCeoMessage`.
 * Den Lauf beim Empfänger beantragt der Planer (P06) nach seinen Weckregeln: `auftrag` und
 * `frage` wecken, `info` nicht.
 */

export const API_PREFIX = "/api/";
export const LIVE_PATH = "/api/live";
/** Größte Anfrage: eine Nachricht hat höchstens 20.000 Zeichen, in JSON bis zu 6 Bytes je Zeichen. */
export const MAX_BODY_BYTES = 128 * 1024;
export const DEFAULT_TIMELINE_LIMIT = 200;
export const MAX_TIMELINE_LIMIT = 500;
/** Gleichzeitige WebSockets je Sitzung. [Annahme: 5, ein paar Tabs] */
export const MAX_SOCKETS_PER_SESSION = 5;
/** Abstand, in dem das Gateway nach neuen Ereignissen sieht. [Annahme: 1 s] */
export const DEFAULT_POLL_MS = 1000;

/** Erlaubte Methoden je Pfad, für `405` mit `Allow`. */
const ALLOWED_METHODS: Readonly<Record<string, string>> = {
  "/api/session": "GET",
  "/api/login": "POST",
  "/api/logout": "POST",
  "/api/state": "GET",
  "/api/timeline": "GET",
  "/api/chat": "GET, POST",
  "/api/prs": "GET",
  "/api/directives": "GET, POST",
  "/api/directives/revoke": "POST",
  [LIVE_PATH]: "GET",
};

export interface LoginThrottle {
  /** Fehlversuche, ab denen keine Anmeldung mehr geprüft wird. [Annahme: 5] */
  maxFailures: number;
  /** Zeitraum für die Fehlversuche. [Annahme: 15 min] */
  windowMs: number;
}

export const DEFAULT_LOGIN_THROTTLE: Readonly<LoginThrottle> = Object.freeze({
  maxFailures: 5,
  windowMs: 15 * 60_000,
});

export interface GatewayOptions {
  office: Office;
  /** Für die Zeitleiste. Dasselbe Protokoll, aus dem `office` liest. */
  store: EventStore;
  /** Hostname des Webinterface wie im Header `Host`, mit Port, falls nicht 443. */
  host: string;
  /** Liefert den gespeicherten Passwort-Hash oder `null`, wenn keiner eingerichtet ist. */
  passwordHash: () => string | null;
  sessions?: Sessions;
  /**
   * Nach jeder gespeicherten Nachricht des CEO, z. B. um den Planer anzustoßen. Darf ein Promise
   * liefern; ein verworfenes landet im Log.
   */
  onCeoMessage?: (message: Message) => unknown;
  /** Nach jeder gespeicherten Weisung oder Rücknahme, z. B. um die Meldung anzustoßen (E68). */
  onDirective?: () => unknown;
  /** Weisung aus E46 aktiv: Der CEO schreibt nur dem COO. Standard: nein. */
  ceoViaCooOnly?: () => boolean;
  loginThrottle?: Partial<LoginThrottle>;
  pollMs?: number;
  websocket?: WebSocketOptions;
  /** Uhr für die Sperre nach Fehlversuchen und für laufende Läufe. Standard: `Date.now`. */
  now?: () => number;
  /**
   * Derselbe Wert wie beim Planer: Ein Lauf ohne Ende gilt danach als verloren, der Agent als
   * frei. Standard aus `DEFAULT_PLANNER_CONFIG`.
   */
  staleRunMinutes?: number;
  /** Für Fehler, die nicht an den Browser gehen. Standard: `console.error`. */
  log?: (message: string, error: unknown) => void;
  /** Gebautes Webinterface. Standard: `packages/office/web/dist/`. */
  web?: StaticFiles;
  /**
   * Stand des Kontingents vom Supervisor (S04). `null` oder fehlend: nicht angebunden, das
   * Webinterface verweist dann auf Konsole und `aioffice status` (E67).
   */
  quota?: () => QuotaView | null;
  /**
   * Offene PRs aller Repos, gelesen vom Supervisor über die GitHub App (Kap. 5.11, E26). Das
   * Office hält keinen GitHub-Zugang. `null` oder fehlend: noch nicht angebunden.
   */
  pullRequests?: () => PullRequestView[] | null;
  /** Link zur Supervisor-Konsole (Kap. 5.11), nur `https:`. */
  consoleUrl?: string;
}

interface Reply {
  status: number;
  body?: JsonValue;
  /** Statt `body`: eine Datei des Webinterface. */
  file?: { type: string; body: Buffer };
  headers?: Record<string, string | string[]>;
}

class HttpError extends Error {
  readonly reply: Reply;
  constructor(status: number, message?: string, headers?: Record<string, string>) {
    super(`HTTP ${String(status)}`);
    this.reply = {
      status,
      ...(message === undefined ? {} : { body: { error: message } }),
      ...(headers === undefined ? {} : { headers }),
    };
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(",") : value;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Wie in der Office-API: `destroyOnReturn: false`, damit 413 noch gesendet werden kann.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "Anfrage zu groß");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Kein gültiges JSON");
  }
}

function integer(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) {
    return fallback;
  }
  if (!/^\d{1,15}$/.test(value)) {
    throw new HttpError(400, "Zahl erwartet");
  }
  return Math.min(Math.max(Number(value), min), max);
}

function isMessageKind(value: unknown): value is MessageKind {
  return typeof value === "string" && (MESSAGE_KINDS as readonly string[]).includes(value);
}

export class OfficeGateway {
  readonly origin: string;
  readonly sessions: Sessions;
  private readonly options: GatewayOptions;
  private readonly throttle: LoginThrottle;
  private readonly now: () => number;
  private readonly web: StaticFiles;
  private readonly consoleUrl: string | null;
  private failures: number[] = [];
  /** Anmeldungen nacheinander: scrypt braucht viel Speicher und Rechenzeit. */
  private loginQueue: Promise<unknown> = Promise.resolve();
  private readonly peers = new Map<WebSocketPeer, Session>();
  private notifiedSeq: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: GatewayOptions) {
    this.options = options;
    this.origin = `https://${options.host}`;
    this.sessions = options.sessions ?? new Sessions();
    this.throttle = { ...DEFAULT_LOGIN_THROTTLE, ...options.loginThrottle };
    this.now = options.now ?? Date.now;
    this.web = options.web ?? new StaticFiles();
    this.consoleUrl = options.consoleUrl === undefined ? null : checkConsoleUrl(options.consoleUrl);
    this.notifiedSeq = options.office.state.lastSeq;
    this.sessions.onEnd((session) => {
      for (const [peer, owner] of this.peers) {
        if (owner === session) {
          peer.close(CLOSE_CODES.policyViolation, "Sitzung beendet");
        }
      }
    });
  }

  /** Startet die Suche nach neuen Ereignissen für die WebSockets. */
  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      this.poll();
    }, this.options.pollMs ?? DEFAULT_POLL_MS);
    this.timer.unref();
  }

  /** Beendet die Suche und alle WebSockets. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const peer of [...this.peers.keys()]) {
      peer.close(CLOSE_CODES.goingAway, "Office wird beendet");
    }
  }

  /** Zahl offener WebSockets. */
  get liveConnections(): number {
    return this.peers.size;
  }

  /**
   * Meldet neue Ereignisse an alle WebSockets und trennt die, deren Sitzung abgelaufen ist.
   * Läuft im Takt `pollMs`; nach eigenen Schreibvorgängen sofort.
   */
  poll(): void {
    this.sessions.prune();
    for (const [peer, session] of this.peers) {
      if (!this.sessions.isActive(session)) {
        peer.close(CLOSE_CODES.policyViolation, "Sitzung abgelaufen");
      }
    }
    if (this.peers.size === 0) {
      this.notifiedSeq = this.options.office.state.lastSeq;
      return;
    }
    try {
      this.options.office.sync();
    } catch (error) {
      this.log("Gateway: Ereignisse nicht lesbar", error);
      return;
    }
    const lastSeq = this.options.office.state.lastSeq;
    if (lastSeq <= this.notifiedSeq) {
      return;
    }
    this.notifiedSeq = lastSeq;
    const text = JSON.stringify({ type: "events", lastSeq });
    for (const peer of this.peers.keys()) {
      peer.send(text);
    }
  }

  /** Für `http.createServer`. */
  readonly handle = (req: IncomingMessage, res: ServerResponse): void => {
    this.process(req)
      .catch((error: unknown) => {
        if (error instanceof HttpError) {
          return error.reply;
        }
        this.log("Gateway: Fehler", error);
        const reply: Reply = { status: 500, body: { error: "Interner Fehler" } };
        return reply;
      })
      .then((reply) => {
        const body =
          reply.file?.body ?? (reply.body === undefined ? undefined : JSON.stringify(reply.body));
        const type =
          reply.file?.type ??
          (reply.body === undefined ? undefined : "application/json; charset=utf-8");
        // Wie in der Office-API: Antwort vor dem Ende des Inhalts schließt die Verbindung.
        const close = !req.complete;
        res.writeHead(reply.status, {
          ...(type === undefined ? {} : { "content-type": type }),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          ...(close ? { connection: "close" } : {}),
          ...reply.headers,
        });
        res.end(body);
      })
      .catch((error: unknown) => {
        this.log("Gateway: Antwort fehlgeschlagen", error);
        res.destroy();
      });
  };

  /** Für das Ereignis `upgrade` des HTTP-Servers. */
  readonly upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on("error", () => {
      socket.destroy();
    });
    const path = (req.url ?? "").split("?")[0];
    if (header(req, "host") !== this.options.host) {
      refuseUpgrade(socket, { status: 421, message: "Falscher Hostname" });
      return;
    }
    if (path !== LIVE_PATH) {
      refuseUpgrade(socket, { status: 404, message: "Nicht gefunden" });
      return;
    }
    const handshake = checkHandshake(req);
    if (!("key" in handshake)) {
      refuseUpgrade(socket, handshake);
      return;
    }
    // Gegen Cross-Site WebSocket Hijacking: Der Browser schickt `Origin` immer mit.
    if (header(req, "origin") !== this.origin) {
      refuseUpgrade(socket, { status: 403, message: "Fremde Herkunft" });
      return;
    }
    const session = this.sessions.find(sessionIdFromCookie(header(req, "cookie")), false);
    if (session === undefined) {
      refuseUpgrade(socket, { status: 401, message: "Nicht angemeldet" });
      return;
    }
    const open = [...this.peers.values()].filter((s) => s === session).length;
    if (open >= MAX_SOCKETS_PER_SESSION) {
      refuseUpgrade(socket, { status: 429, message: "Zu viele Verbindungen" });
      return;
    }
    const peer = WebSocketPeer.accept(socket, handshake.key, head, this.options.websocket);
    this.peers.set(peer, session);
    peer.onClose(() => {
      this.peers.delete(peer);
    });
    peer.send(JSON.stringify({ type: "events", lastSeq: this.options.office.state.lastSeq }));
  };

  private log(message: string, error: unknown): void {
    (this.options.log ?? console.error)(message, error);
  }

  private async process(req: IncomingMessage): Promise<Reply> {
    if (header(req, "host") !== this.options.host) {
      return { status: 421, body: { error: "Falscher Hostname" } };
    }
    const url = new URL(req.url ?? "/", this.origin);
    const route = `${req.method ?? ""} ${url.pathname}`;
    switch (route) {
      case "GET /api/session":
        return this.read(req, () => this.session(req));
      case "POST /api/login":
        return this.write(req, null, (body) => this.login(req, body));
      case "POST /api/logout":
        return this.write(req, this.authenticate(req), (_body, session) => this.logout(session));
      case "GET /api/state":
        return this.read(req, () => {
          this.authenticate(req);
          return this.state();
        });
      case "GET /api/timeline":
        return this.read(req, () => {
          this.authenticate(req);
          return this.timeline(url.searchParams);
        });
      case "GET /api/chat":
        return this.read(req, () => {
          this.authenticate(req);
          return this.chat(url.searchParams);
        });
      case "POST /api/chat":
        return this.write(req, this.authenticate(req), (body) => this.send(body));
      case "GET /api/prs":
        return this.read(req, () => {
          this.authenticate(req);
          return this.pullRequests();
        });
      case "GET /api/directives":
        return this.read(req, () => {
          this.authenticate(req);
          return this.directives();
        });
      case "POST /api/directives":
        return this.write(req, this.authenticate(req), (body) => this.issueDirective(body));
      case "POST /api/directives/revoke":
        return this.write(req, this.authenticate(req), (body) => this.revokeDirective(body));
      default:
        break;
    }
    // Webinterface: ohne Anmeldung und ohne Prüfung der Herkunft, die Dateien enthalten keine Daten.
    const file = this.web.get(url.pathname);
    if (file !== undefined) {
      return req.method === "GET"
        ? {
            status: 200,
            file,
            headers: { ...WEB_HEADERS, "cache-control": file.cacheControl },
          }
        : { status: 405, body: { error: "Methode nicht erlaubt" }, headers: { allow: "GET" } };
    }
    if (url.pathname === "/" && !this.web.built) {
      return {
        status: 503,
        body: { error: "Webinterface nicht gebaut: pnpm --filter @ai-office/office build:web" },
      };
    }
    const allow = ALLOWED_METHODS[url.pathname];
    if (allow !== undefined) {
      return { status: 405, body: { error: "Methode nicht erlaubt" }, headers: { allow } };
    }
    return { status: 404, body: { error: "Nicht gefunden" } };
  }

  /** Lesende Anfrage: keine fremde Herkunft laut `Sec-Fetch-Site` und `Origin`. */
  private read(req: IncomingMessage, fn: () => Reply): Reply {
    const site = header(req, "sec-fetch-site");
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      throw new HttpError(403, "Fremde Herkunft");
    }
    const origin = header(req, "origin");
    if (origin !== undefined && origin !== this.origin) {
      throw new HttpError(403, "Fremde Herkunft");
    }
    return fn();
  }

  /**
   * Zustandsändernde Anfrage: exakter `Origin`, JSON und bei bestehender Sitzung ihr CSRF-Token.
   * `session` ist `null` nur bei der Anmeldung.
   */
  private async write(
    req: IncomingMessage,
    session: Session | null,
    fn: (body: unknown, session: Session) => Promise<Reply> | Reply,
  ): Promise<Reply> {
    if (header(req, "origin") !== this.origin) {
      throw new HttpError(403, "Fremde Herkunft");
    }
    if (!/^application\/json\s*(;|$)/i.test(header(req, "content-type") ?? "")) {
      throw new HttpError(415, "Nur application/json");
    }
    if (session !== null && !safeEqual(header(req, "x-csrf-token") ?? "", session.csrfToken)) {
      throw new HttpError(403, "CSRF-Token fehlt oder passt nicht");
    }
    const body = await readJson(req);
    // Während der Körper ankam, kann die Sitzung abgemeldet, ersetzt oder abgelaufen sein.
    if (session !== null && !this.sessions.isActive(session)) {
      throw new HttpError(401, "Nicht angemeldet");
    }
    return fn(body, session as Session);
  }

  private authenticate(req: IncomingMessage): Session {
    const session = this.sessions.find(sessionIdFromCookie(header(req, "cookie")));
    if (session === undefined) {
      throw new HttpError(401, "Nicht angemeldet");
    }
    return session;
  }

  private session(req: IncomingMessage): Reply {
    const session = this.sessions.find(sessionIdFromCookie(header(req, "cookie")));
    return {
      status: 200,
      body:
        session === undefined
          ? { authenticated: false }
          : { authenticated: true, csrfToken: session.csrfToken },
    };
  }

  private login(req: IncomingMessage, body: unknown): Promise<Reply> {
    const next = this.loginQueue.then(() => this.checkLogin(req, body));
    this.loginQueue = next.catch(() => undefined);
    return next;
  }

  private async checkLogin(req: IncomingMessage, body: unknown): Promise<Reply> {
    const at = this.now();
    this.failures = this.failures.filter((t) => at - t < this.throttle.windowMs);
    if (this.failures.length >= this.throttle.maxFailures) {
      const oldest = this.failures[0] as number;
      const seconds = Math.ceil((oldest + this.throttle.windowMs - at) / 1000);
      throw new HttpError(429, "Zu viele Fehlversuche, bitte später erneut", {
        "retry-after": String(Math.max(seconds, 1)),
      });
    }
    if (!isRecord(body) || typeof body["password"] !== "string" || Object.keys(body).length !== 1) {
      throw new HttpError(400, "Erwartet: { password }");
    }
    const stored = this.options.passwordHash();
    if (stored === null) {
      throw new HttpError(503, "Kein Passwort eingerichtet");
    }
    if (!(await verifyPassword(body["password"], stored))) {
      this.failures.push(this.now());
      throw new HttpError(401, "Anmeldung fehlgeschlagen");
    }
    this.failures = [];
    // Immer eine neue Sitzung (gegen Session Fixation); eine alte im selben Browser endet.
    const previous = this.sessions.find(sessionIdFromCookie(header(req, "cookie")), false);
    if (previous !== undefined) {
      this.sessions.end(previous);
    }
    const { id, session } = this.sessions.create();
    return {
      status: 200,
      body: { csrfToken: session.csrfToken },
      headers: { "set-cookie": sessionCookie(id, this.sessions.maxAgeMs) },
    };
  }

  private logout(session: Session): Reply {
    this.sessions.end(session);
    return { status: 204, headers: { "set-cookie": clearedSessionCookie() } };
  }

  private state(): Reply {
    const office = this.options.office;
    office.sync();
    const state = office.state;
    const costs = new Map<string, number>();
    let total = 0;
    let runCount = 0;
    for (const run of state.runs()) {
      runCount += 1;
      costs.set(run.agentId, (costs.get(run.agentId) ?? 0) + run.totalCostUsd);
      total += run.totalCostUsd;
    }
    // Dieselbe Regel wie im Planer, damit ein verlorener Lauf den Agenten nicht für immer belegt.
    const config: PlannerConfig = {
      ...DEFAULT_PLANNER_CONFIG,
      staleRunMinutes: this.options.staleRunMinutes ?? DEFAULT_PLANNER_CONFIG.staleRunMinutes,
    };
    const now = new Date(this.now());
    return {
      status: 200,
      body: {
        lastSeq: state.lastSeq,
        cooId: office.cooId(),
        ceoViaCooOnly: this.options.ceoViaCooOnly?.() ?? false,
        agents: state.agents().map((agent) => ({
          id: agent.id,
          name: agent.name,
          role: agent.role,
          supervisorId: agent.supervisorId,
          roomId: agent.roomId,
          roomName: findRoom(state.building, agent.roomId)?.name ?? null,
          avatarSeed: agent.avatarSeed,
          running: activeRun(state, agent.id, now, config) !== undefined,
          costUsd: costs.get(agent.id) ?? 0,
        })),
        openTasks: state
          .tasks()
          .filter((task) => !CLOSED_STATUSES.includes(task.status))
          .map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            assigneeId: task.assigneeId,
            runType: task.runType,
            repo: task.repo,
          })),
        costs: { totalUsd: total, runs: runCount },
        quota: this.quota(),
        consoleUrl: this.consoleUrl,
      },
    };
  }

  /** Kontingent vom Supervisor, geprüft. Ungültige Daten landen im Log, nicht beim Browser. */
  private quota(): JsonValue {
    let value: QuotaView | null | undefined;
    try {
      value = this.options.quota?.();
    } catch (error) {
      this.log("Gateway: Kontingent nicht lesbar", error);
      return null;
    }
    if (value === undefined || value === null) {
      return null;
    }
    const result = quotaViewSchema.safeParse(value);
    if (!result.success) {
      this.log("Gateway: Kontingent ungültig", result.error);
      return null;
    }
    return result.data;
  }

  private pullRequests(): Reply {
    let list: PullRequestView[] | null | undefined;
    try {
      list = this.options.pullRequests?.();
    } catch (error) {
      this.log("Gateway: PRs nicht lesbar", error);
      return { status: 200, body: { available: false, pullRequests: [] } };
    }
    if (list === undefined || list === null) {
      return { status: 200, body: { available: false, pullRequests: [] } };
    }
    const result = pullRequestListSchema.safeParse(list);
    if (!result.success) {
      this.log("Gateway: PRs ungültig", result.error);
      return { status: 200, body: { available: false, pullRequests: [] } };
    }
    return {
      status: 200,
      body: { available: true, pullRequests: result.data as unknown as JsonValue },
    };
  }

  private timeline(params: URLSearchParams): Reply {
    // Erst angleichen: `lastSeq` darf nie hinter den gelieferten Ereignissen liegen.
    this.options.office.sync();
    const office = this.options.office;
    // `last=N`: die jüngsten N Ereignisse, für den ersten Aufbau der Zeitleiste.
    const last = params.get("last");
    if (last !== null && (params.get("after") !== null || params.get("limit") !== null)) {
      throw new HttpError(400, "last schließt after und limit aus");
    }
    let afterSeq: number;
    let limit: number;
    if (last === null) {
      afterSeq = integer(params.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
      limit = integer(params.get("limit"), DEFAULT_TIMELINE_LIMIT, 1, MAX_TIMELINE_LIMIT);
    } else {
      limit = integer(last, DEFAULT_TIMELINE_LIMIT, 1, MAX_TIMELINE_LIMIT);
      // Sequenzen sind lückenlos; gäbe es Lücken, kämen nur weniger als N Ereignisse.
      afterSeq = Math.max(office.state.lastSeq - limit, 0);
    }
    const events = this.options.store.read({ afterSeq, limit });
    return {
      status: 200,
      body: {
        events: events.map((event) => ({
          seq: event.seq,
          id: event.id,
          type: event.type,
          version: event.version,
          actor: event.actor,
          runId: event.runId,
          occurredAt: event.occurredAt,
          payload: event.payload,
          // Kosten des Laufs, aus dem die Handlung stammt (AK 11), sobald er beendet ist.
          runCostUsd:
            event.runId === null ? null : (office.state.run(event.runId)?.totalCostUsd ?? null),
        })),
        // Schreibt ein anderer Prozess zwischen `sync()` und `read()`, zählt das gelesene Ereignis.
        lastSeq: Math.max(office.state.lastSeq, events.at(-1)?.seq ?? 0),
      },
    };
  }

  private chat(params: URLSearchParams): Reply {
    const office = this.options.office;
    office.sync();
    // `last=N`: die jüngsten N Nachrichten, für den ersten Aufbau des Chats.
    const last = params.get("last");
    if (last !== null && (params.get("after") !== null || params.get("limit") !== null)) {
      throw new HttpError(400, "last schließt after und limit aus");
    }
    const afterSeq = integer(params.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
    const partner = params.get("with");
    const all = office.state
      .messages({ afterSeq })
      .filter((m) => m.fromId === CEO_ID || m.toId === CEO_ID)
      .filter((m) => partner === null || m.fromId === partner || m.toId === partner);
    const messages =
      last === null
        ? all.slice(0, integer(params.get("limit"), DEFAULT_TIMELINE_LIMIT, 1, MAX_TIMELINE_LIMIT))
        : all.slice(-integer(last, DEFAULT_TIMELINE_LIMIT, 1, MAX_TIMELINE_LIMIT));
    return { status: 200, body: { messages: messages as unknown as JsonValue } };
  }

  /** Alle Weisungen, neueste zuerst, auch zurückgenommene (Kap. 4.4, E68). */
  private directives(): Reply {
    const office = this.options.office;
    office.sync();
    const directives = office.state.directives().reverse();
    return {
      status: 200,
      body: {
        directives: directives as unknown as JsonValue,
        maxChars: MAX_DIRECTIVE_CHARS,
        maxCharsPerAgent: MAX_DIRECTIVE_CHARS_PER_AGENT,
      },
    };
  }

  private issueDirective(body: unknown): Reply {
    if (!isRecord(body)) {
      throw new HttpError(400, "Erwartet: { text, agentIds, clientId? }");
    }
    const unknown = Object.keys(body).filter(
      (key) => !["text", "agentIds", "clientId"].includes(key),
    );
    if (unknown.length > 0) {
      throw new HttpError(400, `Unbekannte Felder: ${unknown.join(", ")}`);
    }
    const text = body["text"];
    const agentIds = body["agentIds"] ?? null;
    if (typeof text !== "string") {
      throw new HttpError(422, "Text fehlt");
    }
    if (
      agentIds !== null &&
      (!Array.isArray(agentIds) || !agentIds.every((id) => typeof id === "string"))
    ) {
      throw new HttpError(422, "agentIds: Liste von Agenten-IDs oder null für alle");
    }
    const clientId = clientIdOf(body);
    return this.command(() =>
      this.options.office.issueDirective(
        { text, agentIds },
        clientId === null ? {} : { idempotencyKey: `ceo-weisung:${clientId}` },
      ),
    );
  }

  private revokeDirective(body: unknown): Reply {
    if (!isRecord(body) || typeof body["id"] !== "string" || Object.keys(body).length !== 1) {
      throw new HttpError(400, "Erwartet: { id }");
    }
    const id = body["id"];
    return this.command(() =>
      this.options.office.revokeDirective(id, { idempotencyKey: `ceo-weisung-zurueck:${id}` }),
    );
  }

  /** Führt einen Befehl des CEO aus; Prüffehler werden 422. */
  private command(run: () => Directive): Reply {
    let directive: Directive;
    try {
      directive = run();
    } catch (error) {
      if (error instanceof ValidationError) {
        return { status: 422, body: { error: error.message, issues: [...error.issues] } };
      }
      if (error instanceof DomainError) {
        return { status: 422, body: { error: error.message } };
      }
      throw error;
    }
    try {
      const result = this.options.onDirective?.();
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          this.log("Gateway: onDirective fehlgeschlagen", error);
        });
      }
    } catch (error) {
      this.log("Gateway: onDirective fehlgeschlagen", error);
    }
    this.poll();
    return { status: 201, body: { directive: directive as unknown as JsonValue } };
  }

  private send(body: unknown): Reply {
    if (!isRecord(body)) {
      throw new HttpError(400, "Erwartet: { text, to?, kind?, clientId? }");
    }
    const allowed = new Set(["text", "to", "kind", "taskId", "replyToId", "clientId"]);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new HttpError(400, `Unbekannte Felder: ${unknown.join(", ")}`);
    }
    const office = this.options.office;
    office.sync();
    const coo = office.cooId();
    const to = body["to"] ?? coo;
    if (typeof to !== "string") {
      throw new HttpError(422, "Kein Empfänger: Es gibt keinen COO, bitte `to` angeben");
    }
    if ((this.options.ceoViaCooOnly?.() ?? false) && to !== coo) {
      // E46: Komfort im Office; durchgesetzt wird die Weisung bei Eskalationen im Supervisor.
      throw new HttpError(422, "Weisung aktiv: Der CEO schreibt nur dem COO");
    }
    if (to === CEO_ID || office.state.agent(to) === undefined) {
      throw new HttpError(422, `Unbekannter Empfänger ${to}`);
    }
    const kind = body["kind"] ?? "auftrag";
    if (!isMessageKind(kind)) {
      throw new HttpError(422, `Art muss eine von ${MESSAGE_KINDS.join(", ")} sein`);
    }
    if (typeof body["text"] !== "string") {
      throw new HttpError(422, "Text fehlt");
    }
    const clientId = clientIdOf(body) ?? undefined;
    const optionalId = (name: string): string | null => {
      const value = body[name];
      if (value === undefined || value === null) {
        return null;
      }
      if (typeof value !== "string") {
        throw new HttpError(422, `${name} muss eine Zeichenkette sein`);
      }
      return value;
    };
    let message: Message;
    try {
      message = office.sendMessage(
        CEO_ID,
        {
          toId: to,
          kind,
          text: body["text"],
          taskId: optionalId("taskId"),
          replyToId: optionalId("replyToId"),
        },
        // Wiederholt der Browser nach einem Abbruch, entsteht dieselbe Nachricht nicht zweimal.
        clientId === undefined ? {} : { idempotencyKey: `ceo-chat:${clientId}` },
      );
    } catch (error) {
      if (error instanceof ValidationError) {
        return { status: 422, body: { error: error.message, issues: [...error.issues] } };
      }
      if (error instanceof DomainError) {
        return { status: 422, body: { error: error.message } };
      }
      throw error;
    }
    // Die Antwort wartet nicht auf den Haken. Ein Fehler, auch ein verworfenes Promise, landet
    // im Log; die Nachricht ist dann schon gespeichert.
    try {
      const result = this.options.onCeoMessage?.(message);
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          this.log("Gateway: onCeoMessage fehlgeschlagen", error);
        });
      }
    } catch (error) {
      this.log("Gateway: onCeoMessage fehlgeschlagen", error);
    }
    this.poll();
    return { status: 201, body: { message: message as unknown as JsonValue } };
  }
}

/** HTTP-Server mit dem Gateway, auch für WebSockets. */
export function createGatewayServer(gateway: OfficeGateway): Server {
  const server = createServer(gateway.handle);
  server.on("upgrade", gateway.upgrade);
  return server;
}

/** Kennung des Browsers für Wiederholungen nach einem Abbruch, sonst `null`. */
function clientIdOf(body: Record<string, unknown>): string | null {
  const clientId = body["clientId"];
  if (clientId === undefined) {
    return null;
  }
  if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) {
    throw new HttpError(422, "clientId: 8 bis 64 Zeichen aus A–Z, a–z, 0–9, _ und -");
  }
  return clientId;
}
