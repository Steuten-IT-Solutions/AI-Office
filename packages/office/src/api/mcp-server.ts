import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Office } from "../domain/office.ts";
import { Reader, isRecord } from "../domain/validation.ts";
import { canonicalJson, type JsonValue } from "../events/canonical-json.ts";
import { OFFICE_VERSION } from "../version.ts";
import type { RunGrant, RunTokens } from "./run-tokens.ts";
import { TOOLS, toolErrorText, type EscalationGate } from "./tools.ts";

/**
 * MCP-Endpunkt der Office-API (P08, plan.md Kap. 3.2, 4.6, 5.7).
 *
 * Umgesetzt ist der Transport „Streamable HTTP“ der MCP-Revision 2026-07-28 in dem Umfang, den
 * die Werkzeuge brauchen: `server/discover`, `tools/list`, `tools/call`. Die Revision ist
 * zustandslos (keine Sitzung, kein `initialize`); jede Anfrage trägt Version und Fähigkeiten in
 * `_meta`. Quelle: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
 *
 * Eigene Umsetzung statt `@modelcontextprotocol/sdk`: Das SDK bringt u. a. Express, Hono, CORS
 * und JOSE mit; wir brauchen davon nichts (E34). Geantwortet wird immer mit einem einzelnen
 * JSON-Objekt, nie mit SSE; das erlaubt der Transport.
 *
 * Den Container behandelt das Office als feindlich (Kap. 3.1 Nr. 4): Jede Anfrage braucht das
 * Office-Token des Laufs, Größe und Zahl der Aufrufe sind begrenzt.
 */

export const MCP_PATH = "/mcp";
export const PROTOCOL_VERSION = "2026-07-28";
export const SUPPORTED_VERSIONS: readonly string[] = [PROTOCOL_VERSION];
/** Größte Anfrage. [Annahme: 256 KiB; ein Werkzeugaufruf hat höchstens ~80 KB Text] */
export const MAX_BODY_BYTES = 256 * 1024;
/** Höchstzahl Werkzeugaufrufe je Lauf. [Annahme: 200] */
export const MAX_CALLS_PER_RUN = 200;

const SERVER_INFO = { name: "ai-office", version: OFFICE_VERSION };
const META = { "io.modelcontextprotocol/serverInfo": SERVER_INFO };
/** Wie lange ein Client `tools/list` und `server/discover` zwischenspeichern darf. */
const TTL_MS = 3_600_000;

/** JSON-RPC-Fehlercodes (JSON-RPC 2.0 und MCP 2026-07-28). */
export const ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
} as const;

export interface OfficeApiOptions {
  office: Office;
  tokens: RunTokens;
  gate: EscalationGate;
  /** Weisung aus E46 aktiv? Standard: nein. */
  ceoViaCooOnly?: () => boolean;
  now?: () => Date;
  /** Für Fehler, die nicht ans Modell gehen. Standard: `console.error`. */
  log?: (message: string, error: unknown) => void;
}

type RequestId = string | number;

interface Reply {
  status: number;
  body?: JsonValue;
  headers?: Record<string, string>;
}

class HttpError extends Error {
  readonly reply: Reply;
  constructor(reply: Reply) {
    super(`HTTP ${String(reply.status)}`);
    this.reply = reply;
  }
}

function rpcError(
  status: number,
  id: RequestId | null,
  code: number,
  message: string,
  data?: JsonValue,
): Reply {
  return {
    status,
    body: {
      jsonrpc: "2.0",
      ...(id === null ? {} : { id }),
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
  };
}

function rpcResult(id: RequestId, result: Record<string, JsonValue>): Reply {
  return {
    status: 200,
    body: { jsonrpc: "2.0", id, result: { resultType: "complete", ...result, _meta: META } },
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(",") : value;
}

/** Dekodiert das Base64-Format `=?base64?…?=` aus dem Transport (Abschnitt „Value Encoding“). */
export function decodeHeaderValue(value: string): string {
  const match = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(value);
  return match === null ? value : Buffer.from(match[1] as string, "base64").toString("utf8");
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError({ status: 413 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class OfficeApi {
  private readonly options: OfficeApiOptions;
  private readonly calls = new Map<string, number>();

  constructor(options: OfficeApiOptions) {
    this.options = options;
  }

  /** Für `http.createServer`. */
  readonly handle = (req: IncomingMessage, res: ServerResponse): void => {
    this.process(req)
      .catch((error: unknown) => {
        if (error instanceof HttpError) {
          return error.reply;
        }
        (this.options.log ?? console.error)("Office-API: Fehler", error);
        return rpcError(500, null, ERRORS.internal, "Interner Fehler");
      })
      .then((reply) => {
        const body = reply.body === undefined ? undefined : JSON.stringify(reply.body);
        res.writeHead(reply.status, {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "cache-control": "no-store",
          ...reply.headers,
        });
        res.end(body);
      })
      .catch((error: unknown) => {
        (this.options.log ?? console.error)("Office-API: Antwort fehlgeschlagen", error);
        res.destroy();
      });
  };

  private async process(req: IncomingMessage): Promise<Reply> {
    const path = (req.url ?? "").split("?")[0];
    if (path !== MCP_PATH) {
      return { status: 404 };
    }
    if (req.method !== "POST") {
      // GET-Strom und DELETE einer Sitzung gibt es in 2026-07-28 nicht.
      return { status: 405, headers: { allow: "POST" } };
    }
    if (header(req, "origin") !== undefined) {
      // Container senden kein Origin; ein Browser schon (Schutz gegen DNS-Rebinding).
      return { status: 403 };
    }
    const grant = this.authenticate(req);
    if (!/^application\/json\b/i.test(header(req, "content-type") ?? "")) {
      return { status: 415 };
    }
    let message: unknown;
    try {
      message = JSON.parse(await readBody(req));
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      return rpcError(400, null, ERRORS.parse, "Kein gültiges JSON");
    }
    if (
      !isRecord(message) ||
      message["jsonrpc"] !== "2.0" ||
      typeof message["method"] !== "string"
    ) {
      return rpcError(400, null, ERRORS.invalidRequest, "Keine JSON-RPC-2.0-Anfrage");
    }
    if (!("id" in message)) {
      // Benachrichtigung. 2026-07-28 definiert keine vom Client über HTTP.
      return { status: 202 };
    }
    const id = message["id"];
    if (typeof id !== "string" && !Number.isSafeInteger(id)) {
      return rpcError(400, null, ERRORS.invalidRequest, "id muss Text oder ganze Zahl sein");
    }
    return this.dispatch(req, grant, id as RequestId, message["method"], message["params"]);
  }

  /** Office-Token prüfen. Ein abgeschlossener Lauf darf nichts mehr tun. */
  private authenticate(req: IncomingMessage): RunGrant {
    const match = /^Bearer ([\x21-\x7e]+)$/.exec(header(req, "authorization") ?? "");
    const now = (this.options.now ?? (() => new Date()))();
    const grant = match === null ? null : this.options.tokens.resolve(match[1] as string, now);
    if (grant === null) {
      throw new HttpError({ status: 401, headers: { "www-authenticate": "Bearer" } });
    }
    this.options.office.sync();
    if (this.options.office.state.run(grant.runId) !== undefined) {
      throw new HttpError({ status: 401, headers: { "www-authenticate": "Bearer" } });
    }
    return grant;
  }

  private async dispatch(
    req: IncomingMessage,
    grant: RunGrant,
    id: RequestId,
    method: string,
    params: unknown,
  ): Promise<Reply> {
    const meta = isRecord(params) && isRecord(params["_meta"]) ? params["_meta"] : {};
    const version = header(req, "mcp-protocol-version");
    const bodyVersion = meta["io.modelcontextprotocol/protocolVersion"];
    if (version === undefined || version !== bodyVersion) {
      return rpcError(
        400,
        id,
        ERRORS.headerMismatch,
        `MCP-Protocol-Version fehlt oder passt nicht zu _meta. Unterstützt: ${SUPPORTED_VERSIONS.join(", ")}`,
      );
    }
    if (!SUPPORTED_VERSIONS.includes(version)) {
      return rpcError(400, id, ERRORS.unsupportedVersion, "Unsupported protocol version", {
        supported: [...SUPPORTED_VERSIONS],
        requested: version,
      });
    }
    if (header(req, "mcp-method") !== method) {
      return rpcError(400, id, ERRORS.headerMismatch, "Mcp-Method passt nicht zur Anfrage");
    }
    switch (method) {
      case "server/discover":
        return rpcResult(id, {
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          instructions:
            "Werkzeuge des Büros. Jeder Aufruf wird ein Ereignis. Einzelheiten im Buch „Office-API“.",
          ttlMs: TTL_MS,
          cacheScope: "private",
        });
      case "tools/list":
        return rpcResult(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
          ttlMs: TTL_MS,
          cacheScope: "private",
        });
      case "tools/call":
        return this.callTool(req, grant, id, params);
      default:
        return rpcError(404, id, ERRORS.methodNotFound, `Methode ${method} gibt es nicht`);
    }
  }

  private async callTool(
    req: IncomingMessage,
    grant: RunGrant,
    id: RequestId,
    params: unknown,
  ): Promise<Reply> {
    const p = isRecord(params) ? params : {};
    const name = p["name"];
    if (typeof name !== "string") {
      return rpcError(200, id, ERRORS.invalidParams, "params.name fehlt");
    }
    const nameHeader = header(req, "mcp-name");
    if (nameHeader === undefined || decodeHeaderValue(nameHeader) !== name) {
      return rpcError(400, id, ERRORS.headerMismatch, "Mcp-Name fehlt oder passt nicht");
    }
    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined) {
      return rpcError(200, id, ERRORS.invalidParams, `Unbekanntes Werkzeug: ${name}`);
    }
    const args: unknown = p["arguments"] ?? {};
    if (!isRecord(args)) {
      return rpcError(200, id, ERRORS.invalidParams, "params.arguments muss ein Objekt sein");
    }

    const count = (this.calls.get(grant.runId) ?? 0) + 1;
    this.calls.set(grant.runId, count);
    if (count > MAX_CALLS_PER_RUN) {
      return this.toolResult(
        id,
        `Zu viele Aufrufe in diesem Lauf (höchstens ${String(MAX_CALLS_PER_RUN)}).`,
        null,
      );
    }
    try {
      const output = await tool.run(
        {
          office: this.options.office,
          grant,
          idempotencyKey: idempotencyKey(grant.runId, name, args as JsonValue),
          gate: this.options.gate,
          ceoViaCooOnly: this.options.ceoViaCooOnly ?? (() => false),
          now: (this.options.now ?? (() => new Date()))(),
        },
        new Reader(args),
      );
      return this.toolResult(id, output.text, output.structured);
    } catch (error) {
      const text = toolErrorText(error);
      if (text === null) {
        throw error;
      }
      return this.toolResult(id, text, null);
    }
  }

  private toolResult(
    id: RequestId,
    text: string,
    structured: Record<string, JsonValue> | null,
  ): Reply {
    return rpcResult(id, {
      content: [{ type: "text", text }],
      ...(structured === null
        ? { isError: true }
        : { structuredContent: structured, isError: false }),
    });
  }
}

/**
 * Idempotenzschlüssel eines Werkzeugaufrufs: Lauf-ID, Werkzeug und Prüfsumme der Argumente.
 *
 * Kap. 5.7 nennt „Lauf-ID und Sequenznummer“. Die JSON-RPC-`id` taugt dafür nicht: Nach einem
 * abgerissenen Strom muss der Client die Anfrage mit **neuer** `id` wiederholen (MCP 2026-07-28,
 * Changelog Nr. 9). Deshalb zählt der Inhalt: Derselbe Aufruf im selben Lauf wird nur einmal
 * gebucht und liefert beim zweiten Mal dasselbe Ergebnis.
 */
export function idempotencyKey(runId: string, tool: string, args: JsonValue): string {
  const hash = createHash("sha256").update(canonicalJson(args), "utf8").digest("hex");
  return `${runId}:${tool}:${hash}`;
}

/** HTTP-Server mit dem MCP-Endpunkt. Lauschen (Adresse, Port) regelt der Aufrufer. */
export function createOfficeApiServer(options: OfficeApiOptions): Server {
  return createServer(new OfficeApi(options).handle);
}
