/**
 * MCP-Server als Attrappe über stdio (S1b Lauf 3, S1f, S2d). Jede Antwort ist eine Zeile JSON
 * (stdio-Transport, https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
 *
 * Er beantwortet beide Varianten des Verbindungsaufbaus: `initialize` (bis 2025-11-25) und
 * `server/discover` (2026-07-28, wie die Office-API aus P08). Welche das gepinnte CLI über stdio
 * benutzt, ist nicht geprüft **[Annahme]**; die Attrappe protokolliert es auf stderr.
 *
 * Aufruf: `node mcp-attrappe.ts [--name <n>] [--werkzeuge office|ping] [--marker <datei>]`
 * `--marker` legt beim Start eine Datei an (S1f: Beweis, dass ein fremder Server gestartet wurde).
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { TOOLS } from "../../../packages/office/src/api/tools.ts";
import { isMain, option } from "./cli.ts";

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Plan S2d nennt acht Werkzeuge. Bisher gibt es fünf (P08); die drei aus plan.md Kap. 5.3 und 5.7
 * (`search_books`, `read_book`, `web_fetch`) sind Platzhalter mit ähnlich großem Schema.
 */
const PLACEHOLDERS: ToolInfo[] = [
  {
    name: "search_books",
    title: "Bücher durchsuchen",
    description:
      "Volltextsuche im Bücherregal der Abteilung und in der Bibliothek. Liefert Titel, Kapitel und einen kurzen Auszug je Treffer.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 500 },
        scope: { type: "string", enum: ["regal", "bibliothek", "beide"] },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_book",
    title: "Buch lesen",
    description: "Liest ein Kapitel eines Buchs. Lange Kapitel werden seitenweise geliefert.",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "ID" },
        chapter: { type: "string" },
        page: { type: "integer", minimum: 1 },
      },
      required: ["bookId"],
      additionalProperties: false,
    },
  },
  {
    name: "web_fetch",
    title: "Webseite abrufen",
    description:
      "Lädt eine öffentliche Webseite über den Supervisor und liefert extrahierten Text. Jede URL wird protokolliert.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri", maxLength: 2000 },
        purpose: { type: "string", maxLength: 500 },
      },
      required: ["url", "purpose"],
      additionalProperties: false,
    },
  },
];

export function officeTools(): ToolInfo[] {
  return [
    ...TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    ...PLACEHOLDERS,
  ];
}

const PING: ToolInfo = {
  name: "ping",
  title: "Ping",
  description: "Antwortet mit pong. Nur für Tests.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

type Id = string | number | null;

function result(id: Id, value: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result: value });
}

function error(id: Id, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Beantwortet eine Zeile. `null`: keine Antwort (Benachrichtigung oder kaputte Zeile). */
export function handle(line: string, tools: ToolInfo[], name: string): string | null {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return error(null, -32700, "Parse error");
  }
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return error(null, -32600, "Invalid Request");
  }
  const r = request as Record<string, unknown>;
  const method = typeof r["method"] === "string" ? r["method"] : "";
  if (!("id" in r)) {
    return null;
  }
  const rawId = r["id"];
  const id: Id = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
  const params =
    typeof r["params"] === "object" && r["params"] !== null
      ? (r["params"] as Record<string, unknown>)
      : {};
  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion:
          typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name, version: "0.0.0" },
      });
    case "server/discover":
      return result(id, {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": { name, version: "0.0.0" } },
      });
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools });
    case "tools/call": {
      const toolName = typeof params["name"] === "string" ? params["name"] : "";
      if (!tools.some((t) => t.name === toolName)) {
        return error(id, -32602, `Unbekanntes Werkzeug ${toolName}`);
      }
      const text = toolName === "ping" ? "pong" : `OK (Attrappe, ${toolName})`;
      return result(id, { content: [{ type: "text", text }], isError: false });
    }
    default:
      return error(id, -32601, `Methode ${method} gibt es nicht`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const name = option(args, "--name") ?? "attrappe";
  const tools = option(args, "--werkzeuge") === "office" ? officeTools() : [PING];
  const marker = option(args, "--marker");
  if (marker !== undefined) {
    writeFileSync(marker, `gestartet ${new Date().toISOString()}\n`);
  }
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim() === "") {
      return;
    }
    const method = /"method"\s*:\s*"([^"]+)"/.exec(line)?.[1] ?? "?";
    process.stderr.write(`[${name}] ${method}\n`);
    const answer = handle(line, tools, name);
    if (answer !== null) {
      process.stdout.write(`${answer}\n`);
    }
  });
}

if (isMain(import.meta.url)) {
  main();
}
