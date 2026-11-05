import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/**
 * Schmaler WebSocket-Server nach RFC 6455 für die Live-Updates des Webinterface (P09, plan.md
 * Kap. 3.2, 3.4). Quelle: https://www.rfc-editor.org/rfc/rfc6455
 *
 * Eigene Umsetzung statt einer Abhängigkeit wie `ws`: Node 24 bringt nur einen WebSocket-Client
 * mit, keinen Server. Gebraucht wird wenig, und jede Abhängigkeit im Office ist Angriffsfläche
 * (E34, wie bei der Office-API in P08):
 * - Der Server sendet nur Textnachrichten. Vom Browser nimmt er nur Steuerrahmen an (Ping, Pong,
 *   Close); Daten schickt das Webinterface über HTTP mit CSRF-Token.
 * - Keine Erweiterungen (`permessage-deflate`), keine Unterprotokolle, keine Fragmente.
 * - Ein Ping alle `heartbeatMs`; bleibt das Pong bis zum nächsten aus, wird die Verbindung
 *   getrennt. Ein Browser, der nicht mitliest, wird getrennt, sobald sich mehr als
 *   `maxBufferedBytes` angestaut haben.
 */

/** Fester Wert aus RFC 6455 Abschnitt 1.3 für `Sec-WebSocket-Accept`. */
const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

/** Schließcodes aus RFC 6455 Abschnitt 7.4.1. */
export const CLOSE_CODES = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupportedData: 1003,
  policyViolation: 1008,
  tooBig: 1009,
} as const;

/** Längste Nutzlast eines Steuerrahmens (RFC 6455 Abschnitt 5.5). */
const MAX_CONTROL_PAYLOAD = 125;

/** Wert für `Sec-WebSocket-Accept` zu einem `Sec-WebSocket-Key`. */
export function acceptKey(key: string): string {
  return createHash("sha1")
    .update(key + ACCEPT_GUID)
    .digest("base64");
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return (Array.isArray(value) ? value.join(",") : (value ?? "")).trim();
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t !== ""),
  );
}

/** Abgelehnter Handshake: HTTP-Status, Text und zusätzliche Header. */
export interface HandshakeRefusal {
  status: number;
  message: string;
  headers?: Record<string, string>;
}

/**
 * Prüft den Handshake (RFC 6455 Abschnitt 4.2.1). Gibt den Schlüssel zurück oder die Ablehnung.
 * Herkunft und Anmeldung prüft der Aufrufer.
 */
export function checkHandshake(request: IncomingMessage): { key: string } | HandshakeRefusal {
  if (request.method !== "GET" || request.httpVersion !== "1.1") {
    return { status: 400, message: "WebSocket nur mit GET über HTTP/1.1" };
  }
  if (header(request, "upgrade").toLowerCase() !== "websocket") {
    return { status: 400, message: "Upgrade: websocket fehlt" };
  }
  if (!tokens(header(request, "connection")).has("upgrade")) {
    return { status: 400, message: "Connection: Upgrade fehlt" };
  }
  if (header(request, "sec-websocket-version") !== "13") {
    return {
      status: 426,
      message: "Nur WebSocket-Version 13",
      headers: { "Sec-WebSocket-Version": "13" },
    };
  }
  const key = header(request, "sec-websocket-key");
  // 16 zufällige Bytes in Base64 sind genau 24 Zeichen mit `==` am Ende.
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, "base64").length !== 16) {
    return { status: 400, message: "Sec-WebSocket-Key ungültig" };
  }
  return { key };
}

/** Schreibt eine HTTP-Antwort auf einen abgelehnten Upgrade und schließt die Verbindung. */
export function refuseUpgrade(socket: Duplex, refusal: HandshakeRefusal): void {
  const body = `${refusal.message}\n`;
  const lines = [
    `HTTP/1.1 ${String(refusal.status)} ${refusal.message.replace(/[\r\n]/g, " ")}`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    "Cache-Control: no-store",
    ...Object.entries(refusal.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.end(`${lines.join("\r\n")}\r\n\r\n${body}`);
}

/** Baut einen Rahmen des Servers (unmaskiert, RFC 6455 Abschnitt 5.1). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let head: Buffer;
  if (length < 126) {
    head = Buffer.from([0x80 | opcode, length]);
  } else if (length < 0x10000) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([head, payload]);
}

function closePayload(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, "utf8").subarray(0, MAX_CONTROL_PAYLOAD - 2);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
}

export interface WebSocketOptions {
  /** Abstand der Pings. [Annahme: 30 s] */
  heartbeatMs?: number;
  /** Angestaute Ausgabe, ab der die Verbindung getrennt wird. [Annahme: 1 MiB] */
  maxBufferedBytes?: number;
}

export const DEFAULT_HEARTBEAT_MS = 30_000;
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

/** Eine angenommene Verbindung. Nach `onClose` ist sie unbrauchbar. */
export class WebSocketPeer {
  private readonly socket: Duplex;
  private readonly maxBuffered: number;
  private buffer: Buffer = Buffer.alloc(0);
  private alive = true;
  private closing = false;
  private closed = false;
  private readonly timer: NodeJS.Timeout;
  private readonly closeHandlers: (() => void)[] = [];

  private constructor(socket: Duplex, head: Buffer, options: WebSocketOptions) {
    this.socket = socket;
    this.maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    socket.on("data", (chunk: Buffer) => {
      this.receive(chunk);
    });
    socket.on("close", () => {
      this.finish();
    });
    socket.on("error", () => {
      this.finish();
    });
    this.timer = setInterval(() => {
      this.heartbeat();
    }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    this.timer.unref();
    if (head.length > 0) {
      this.receive(head);
    }
  }

  /**
   * Schließt den Handshake ab (101) und gibt die Verbindung zurück. Vorher muss
   * `checkHandshake` den Schlüssel geliefert und der Aufrufer Herkunft und Anmeldung geprüft
   * haben.
   */
  static accept(
    socket: Duplex,
    key: string,
    head: Buffer,
    options: WebSocketOptions = {},
  ): WebSocketPeer {
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        "",
        "",
      ].join("\r\n"),
    );
    return new WebSocketPeer(socket, head, options);
  }

  get isOpen(): boolean {
    return !this.closing && !this.closed;
  }

  onClose(handler: () => void): void {
    if (this.closed) {
      handler();
    } else {
      this.closeHandlers.push(handler);
    }
  }

  /** Sendet eine Textnachricht. Bei angestauter Ausgabe wird die Verbindung getrennt. */
  send(text: string): void {
    if (!this.isOpen) {
      return;
    }
    if (this.socket.writableLength > this.maxBuffered) {
      this.terminate();
      return;
    }
    this.socket.write(encodeFrame(OPCODE.text, Buffer.from(text, "utf8")));
  }

  /** Sendet einen Close-Rahmen und beendet die Verbindung. */
  close(code: number = CLOSE_CODES.normal, reason = ""): void {
    if (!this.isOpen) {
      return;
    }
    this.closing = true;
    this.socket.end(encodeFrame(OPCODE.close, closePayload(code, reason)));
  }

  /** Trennt sofort, ohne Close-Rahmen. */
  terminate(): void {
    this.closing = true;
    this.socket.destroy();
    this.finish();
  }

  private finish(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.timer);
    for (const handler of this.closeHandlers.splice(0)) {
      handler();
    }
  }

  private heartbeat(): void {
    if (!this.isOpen) {
      return;
    }
    if (!this.alive) {
      this.terminate();
      return;
    }
    this.alive = false;
    this.socket.write(encodeFrame(OPCODE.ping, Buffer.alloc(0)));
  }

  private hasEnded(): boolean {
    return this.closed;
  }

  private receive(chunk: Buffer): void {
    if (this.closed) {
      return;
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const consumed = this.frame();
      // Über eine Methode gelesen: `frame()` kann die Verbindung beenden, das sieht TS hier nicht.
      if (consumed === 0 || this.hasEnded()) {
        return;
      }
      this.buffer = this.buffer.subarray(consumed);
    }
  }

  /** Verarbeitet einen vollständigen Rahmen am Anfang des Puffers; 0, wenn er noch fehlt. */
  private frame(): number {
    const data = this.buffer;
    if (data.length < 2) {
      return 0;
    }
    const first = data[0] as number;
    const second = data[1] as number;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    const length = second & 0x7f;
    // Ohne vereinbarte Erweiterung müssen die RSV-Bits 0 sein; Browser maskieren immer.
    if ((first & 0x70) !== 0 || !masked) {
      this.fail(CLOSE_CODES.protocolError, "Ungültiger Rahmen");
      return 0;
    }
    if (opcode === OPCODE.text || opcode === OPCODE.binary || opcode === OPCODE.continuation) {
      this.fail(CLOSE_CODES.unsupportedData, "Der Server nimmt keine Daten an");
      return 0;
    }
    if (opcode !== OPCODE.close && opcode !== OPCODE.ping && opcode !== OPCODE.pong) {
      this.fail(CLOSE_CODES.protocolError, "Unbekannter Rahmen");
      return 0;
    }
    // Steuerrahmen: nie fragmentiert, höchstens 125 Bytes, also immer die 7-Bit-Länge.
    if (!fin || length > MAX_CONTROL_PAYLOAD) {
      this.fail(CLOSE_CODES.protocolError, "Ungültiger Steuerrahmen");
      return 0;
    }
    const total = 2 + 4 + length;
    if (data.length < total) {
      return 0;
    }
    const mask = data.subarray(2, 6);
    const payload = Buffer.from(data.subarray(6, total));
    for (let i = 0; i < payload.length; i++) {
      payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
    }
    if (opcode === OPCODE.ping) {
      if (this.isOpen) {
        this.socket.write(encodeFrame(OPCODE.pong, payload));
      }
    } else if (opcode === OPCODE.pong) {
      this.alive = true;
    } else {
      // Close: bestätigen (Abschnitt 5.5.1) und Verbindung beenden. Ein eigenes Close war schon
      // unterwegs, dann ist dies die Bestätigung.
      if (this.isOpen) {
        this.closing = true;
        this.socket.end(encodeFrame(OPCODE.close, closePayload(CLOSE_CODES.normal, "")));
      } else {
        this.socket.end();
      }
    }
    return total;
  }

  private fail(code: number, reason: string): void {
    this.buffer = Buffer.alloc(0);
    if (this.isOpen) {
      this.close(code, reason);
    } else {
      this.terminate();
    }
  }
}
