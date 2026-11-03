import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { z } from "zod";
import type { EscalationGate } from "../api/tools.ts";
import {
  ERROR_CODES,
  MAX_FRAME_BYTES,
  METHODS,
  PROTOCOL_VERSION,
  SCHEMA_LOCALE,
  describeIssues,
  type IpcErrorCode,
  type IpcMethod,
  type IpcParams,
  type IpcResult,
} from "./protocol.ts";

/**
 * Client des Office für den Supervisor-Socket (P02, plan.md Kap. 4.6, 4.7).
 *
 * - Eine Verbindung, aufgebaut beim ersten Aufruf. Bricht sie ab, baut der nächste Aufruf eine
 *   neue auf. Ein abgebrochener Aufruf wird nie selbst wiederholt: `run.request` ist nicht
 *   idempotent, ein zweiter Versuch könnte einen zweiten Lauf zulassen.
 * - Der Supervisor beantwortet die Anfragen einer Verbindung nacheinander (S02). Der Client
 *   ordnet Antworten deshalb der Reihe nach zu und prüft zusätzlich die ID.
 * - Jede Antwort läuft gegen ein striktes Schema. Weicht sie ab, gilt die Verbindung als
 *   kaputt: Sie wird geschlossen, und alle offenen Aufrufe scheitern mit `IpcTransportError`.
 */

export const DEFAULT_SOCKET_PATH = "/run/aio/supervisor.sock";

/** Wartezeit je Aufruf. [Annahme: 30 s; Admission prüft nur lokale Zustände] */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Der Supervisor hat geantwortet und den Aufruf abgelehnt, oder die Anfrage war schon im Office
 * ungültig und wurde nicht gesendet. In beiden Fällen ist sicher nichts ausgeführt worden.
 */
export class IpcCallError extends Error {
  override name = "IpcCallError";
  readonly code: IpcErrorCode;
  /** Nur bei `unsupported_version`: die Versionen, die der Supervisor spricht. */
  readonly supported: readonly number[] | undefined;
  /** `false`, wenn die Anfrage schon im Office scheiterte und den Socket nie erreichte. */
  readonly sent: boolean;

  constructor(
    method: IpcMethod,
    error: { code: IpcErrorCode; message: string; supported?: readonly number[] | undefined },
    sent: boolean,
  ) {
    super(`${method}: ${error.code}: ${error.message}`);
    this.code = error.code;
    this.supported = error.supported;
    this.sent = sent;
  }
}

/**
 * Verbindung fehlgeschlagen, abgebrochen, Zeit abgelaufen oder Antwort ungültig. Ist
 * `outcomeUnknown` gesetzt, war die Anfrage schon gesendet: Der Supervisor kann sie ausgeführt
 * haben, etwa einen Lauf zugelassen. Wer das wissen muss, fragt den Zustand ab, statt zu wiederholen.
 */
export class IpcTransportError extends Error {
  override name = "IpcTransportError";
  readonly outcomeUnknown: boolean;

  constructor(message: string, outcomeUnknown: boolean, options?: ErrorOptions) {
    super(message, options);
    this.outcomeUnknown = outcomeUnknown;
  }
}

/** Antwort des Supervisors, Version 1. Die Hülle ist im Supervisor nur als Typ beschrieben. */
const responseEnvelope = z.discriminatedUnion("ok", [
  z.strictObject({
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().nullable(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().nullable(),
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(ERROR_CODES),
      message: z.string(),
      supported: z.array(z.int()).optional(),
    }),
  }),
]);

export interface SupervisorClientOptions {
  socketPath?: string;
  timeoutMs?: number;
  /** Obergrenze einer Zeile in Bytes, in beide Richtungen. Standard: `MAX_FRAME_BYTES`. */
  maxFrameBytes?: number;
}

interface Pending {
  id: string;
  method: IpcMethod;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Connection {
  socket: Socket;
  /** Gesendete Anfragen in der Reihenfolge, in der die Antworten kommen. */
  pending: Pending[];
  chunks: Buffer[];
  buffered: number;
  failed: boolean;
  /**
   * Erst nach dem Verbindungsaufbau gibt Node gepufferte Zeilen an den Kernel. Vorher hat der
   * Supervisor sicher nichts erhalten; danach kann er jede gesendete Anfrage ausgeführt haben.
   */
  connected: boolean;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export class SupervisorClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly maxFrameBytes: number;
  private connection: Connection | undefined;
  private closed = false;

  constructor(options: SupervisorClientOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  }

  /**
   * Ruft eine Methode auf. Die Parameter werden vorher geprüft; eine ungültige Anfrage scheitert
   * mit `IpcCallError` (`sent: false`), ohne den Socket zu erreichen.
   */
  call<M extends IpcMethod>(method: M, params: IpcParams<M>): Promise<IpcResult<M>> {
    if (this.closed) {
      return Promise.reject(new IpcTransportError("Client ist geschlossen", false));
    }
    const checked = METHODS[method].params.safeParse(params, { error: SCHEMA_LOCALE });
    if (!checked.success) {
      return Promise.reject(
        new IpcCallError(
          method,
          { code: "invalid_params", message: describeIssues(checked.error) },
          false,
        ),
      );
    }
    const id = randomUUID();
    const line = JSON.stringify({ v: PROTOCOL_VERSION, id, method, params: checked.data });
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > this.maxFrameBytes) {
      return Promise.reject(
        new IpcCallError(
          method,
          {
            code: "invalid_frame",
            message: `Anfrage hat ${String(bytes)} Bytes, erlaubt sind ${String(this.maxFrameBytes)}`,
          },
          false,
        ),
      );
    }
    const connection = this.connect();
    return new Promise<IpcResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const message = connection.connected
          ? `${method}: keine Antwort nach ${String(this.timeoutMs)} ms; Ergebnis unbekannt`
          : `${method}: keine Verbindung nach ${String(this.timeoutMs)} ms; nichts gesendet`;
        this.fail(connection, new IpcTransportError(message, connection.connected));
      }, this.timeoutMs);
      connection.pending.push({
        id,
        method,
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });
      // Gepuffert, bis die Verbindung steht. Scheitert sie, lehnt `fail` den Aufruf ab.
      connection.socket.write(`${line}\n`);
    });
  }

  /** Wartet auf offene Aufrufe und schließt dann die Verbindung. Danach scheitert jeder Aufruf. */
  async close(): Promise<void> {
    this.closed = true;
    const connection = this.connection;
    if (connection === undefined) {
      return;
    }
    await Promise.allSettled(
      connection.pending.map(
        (entry) =>
          new Promise<void>((done) => {
            const { resolve, reject } = entry;
            entry.resolve = (value) => {
              resolve(value);
              done();
            };
            entry.reject = (error) => {
              reject(error);
              done();
            };
          }),
      ),
    );
    if (!connection.failed) {
      await new Promise<void>((done) => {
        connection.socket.end(done);
      });
    }
    connection.socket.destroy();
    if (this.connection === connection) {
      this.connection = undefined;
    }
  }

  private connect(): Connection {
    if (this.connection !== undefined && !this.connection.failed) {
      return this.connection;
    }
    const socket = createConnection({ path: this.socketPath });
    // Eine ruhende Verbindung hält den Prozess nicht am Leben; offene Aufrufe tun es über ihren Timer.
    socket.unref();
    const connection: Connection = {
      socket,
      pending: [],
      chunks: [],
      buffered: 0,
      failed: false,
      connected: false,
    };
    this.connection = connection;
    socket.on("connect", () => {
      connection.connected = true;
    });
    socket.on("data", (chunk: Buffer) => {
      this.receive(connection, chunk);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const { connected } = connection;
      const message = connected
        ? `Verbindung zum Supervisor abgebrochen (${error.code ?? error.message})`
        : `Supervisor unter ${this.socketPath} nicht erreichbar (${error.code ?? error.message})`;
      this.fail(connection, new IpcTransportError(message, connected, { cause: error }));
    });
    socket.on("close", () => {
      this.fail(
        connection,
        new IpcTransportError("Supervisor hat die Verbindung geschlossen", connection.connected),
      );
    });
    return connection;
  }

  private receive(connection: Connection, chunk: Buffer): void {
    let rest = chunk;
    for (;;) {
      if (connection.failed) {
        return;
      }
      const newline = rest.indexOf(0x0a);
      if (newline === -1) {
        connection.buffered += rest.length;
        if (connection.buffered > this.maxFrameBytes) {
          this.fail(
            connection,
            protocolError(`Antwort länger als ${String(this.maxFrameBytes)} Bytes`),
          );
          return;
        }
        if (rest.length > 0) {
          connection.chunks.push(rest);
        }
        return;
      }
      const head = rest.subarray(0, newline);
      if (connection.buffered + head.length > this.maxFrameBytes) {
        this.fail(
          connection,
          protocolError(`Antwort länger als ${String(this.maxFrameBytes)} Bytes`),
        );
        return;
      }
      const frame = Buffer.concat([...connection.chunks, head]);
      connection.chunks = [];
      connection.buffered = 0;
      rest = rest.subarray(newline + 1);
      this.handleFrame(connection, frame);
    }
  }

  private handleFrame(connection: Connection, frame: Buffer): void {
    const entry = connection.pending[0];
    if (entry === undefined) {
      this.fail(connection, protocolError("Antwort ohne offene Anfrage"));
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(utf8.decode(frame));
    } catch {
      this.fail(connection, protocolError("Antwort ist kein gültiges JSON in UTF-8"));
      return;
    }
    const envelope = responseEnvelope.safeParse(raw, { error: SCHEMA_LOCALE });
    if (!envelope.success) {
      this.fail(connection, protocolError(`Antwort ungültig: ${describeIssues(envelope.error)}`));
      return;
    }
    const response = envelope.data;
    // `null` nur, wenn der Supervisor die ID nicht lesen konnte; dann gilt die Antwort der ältesten
    // Anfrage, denn er antwortet der Reihe nach. Ein Erfolg ohne ID wäre ein Protokollfehler.
    if (response.id !== entry.id && !(response.id === null && !response.ok)) {
      this.fail(connection, protocolError("Antwort passt nicht zur nächsten offenen Anfrage"));
      return;
    }
    if (!response.ok) {
      connection.pending.shift();
      clearTimeout(entry.timer);
      entry.reject(new IpcCallError(entry.method, response.error, true));
      return;
    }
    const result = METHODS[entry.method].result.safeParse(response.result, {
      error: SCHEMA_LOCALE,
    });
    if (!result.success) {
      this.fail(
        connection,
        protocolError(`Ergebnis von ${entry.method} ungültig: ${describeIssues(result.error)}`),
      );
      return;
    }
    connection.pending.shift();
    clearTimeout(entry.timer);
    entry.resolve(result.data);
  }

  /** Schließt die Verbindung und lehnt alle offenen Aufrufe ab. Mehrfacher Aufruf schadet nicht. */
  private fail(connection: Connection, error: IpcTransportError): void {
    const pending = connection.pending;
    connection.pending = [];
    connection.failed = true;
    connection.socket.destroy();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}

function protocolError(message: string): IpcTransportError {
  // Die Anfrage war gesendet; was der Supervisor getan hat, ist offen.
  return new IpcTransportError(`Protokollfehler: ${message}`, true);
}

/**
 * `EscalationGate` aus P08 über den Supervisor. Scheitert der Aufruf, wirft das Gate: Ohne
 * Antwort des Supervisors geht keine Eskalation an den CEO durch.
 */
export function supervisorEscalationGate(client: SupervisorClient): EscalationGate {
  return {
    async checkEscalationToCeo(request) {
      const verdict = await client.call("escalation.checkToCeo", request);
      return verdict.allowed ? null : verdict.reason;
    },
  };
}
