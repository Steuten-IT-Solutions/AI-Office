/**
 * Parser für die Ausgabe von `claude -p --output-format stream-json --verbose`.
 *
 * Grundlage sind die Nachrichtentypen der Agent-SDK-Referenz
 * (https://code.claude.com/docs/en/agent-sdk/typescript, Abschnitte SDKMessage,
 * SDKAssistantMessage, SDKResultMessage, SDKRateLimitEvent, SDKAPIRetryMessage).
 * Der Parser ist absichtlich nachsichtig: Unbekannte Nachrichtentypen und fehlende Felder führen
 * nicht zum Abbruch, weil das CLI neue Typen ergänzen kann (R9).
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ModelCost extends TokenUsage {
  costUsd: number;
}

export type RunEvent =
  | {
      kind: "init";
      sessionId: string;
      model: string;
      claudeCodeVersion: string;
      tools: string[];
      mcpServers: { name: string; status: string }[];
    }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; content: string }
  | {
      kind: "rate_limit";
      status: "allowed" | "allowed_warning" | "rejected" | "unknown";
      resetsAt: number | null;
      utilization: number | null;
    }
  | { kind: "api_retry"; attempt: number; error: string; errorStatus: number | null }
  | { kind: "assistant_error"; error: string }
  | {
      kind: "result";
      subtype: string;
      isError: boolean;
      text: string | null;
      errors: string[];
      numTurns: number;
      durationMs: number;
      totalCostUsd: number;
      usage: TokenUsage;
      modelUsage: Record<string, ModelCost>;
      permissionDenials: number;
    }
  | { kind: "unknown"; type: string; subtype: string | null }
  | { kind: "invalid"; excerpt: string };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Längenbegrenzung für Werkzeugergebnisse im Ereignisprotokoll. */
export const MAX_TOOL_RESULT_CHARS = 2000;

function truncate(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}… [gekürzt, ${String(text.length)} Zeichen]`
    : text;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return arr(content)
    .map((block) => (isObject(block) && block["type"] === "text" ? str(block["text"]) : ""))
    .filter((text) => text !== "")
    .join("\n");
}

function usageFrom(value: unknown): TokenUsage {
  const u = isObject(value) ? value : {};
  return {
    inputTokens: num(u["input_tokens"]),
    outputTokens: num(u["output_tokens"]),
    cacheReadInputTokens: num(u["cache_read_input_tokens"]),
    cacheCreationInputTokens: num(u["cache_creation_input_tokens"]),
  };
}

function modelUsageFrom(value: unknown): Record<string, ModelCost> {
  const result: Record<string, ModelCost> = {};
  if (!isObject(value)) {
    return result;
  }
  for (const [model, raw] of Object.entries(value)) {
    const m = isObject(raw) ? raw : {};
    result[model] = {
      inputTokens: num(m["inputTokens"]),
      outputTokens: num(m["outputTokens"]),
      cacheReadInputTokens: num(m["cacheReadInputTokens"]),
      cacheCreationInputTokens: num(m["cacheCreationInputTokens"]),
      costUsd: num(m["costUSD"]),
    };
  }
  return result;
}

function rateStatus(value: unknown): "allowed" | "allowed_warning" | "rejected" | "unknown" {
  return value === "allowed" || value === "allowed_warning" || value === "rejected"
    ? value
    : "unknown";
}

/** Wandelt eine Zeile in null bis mehrere Ereignisse um. */
export function parseLine(line: string): RunEvent[] {
  const trimmed = line.trim();
  if (trimmed === "") {
    return [];
  }
  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return [{ kind: "invalid", excerpt: trimmed.slice(0, 200) }];
  }
  if (!isObject(message)) {
    return [{ kind: "invalid", excerpt: trimmed.slice(0, 200) }];
  }
  const type = str(message["type"]);
  const subtype = typeof message["subtype"] === "string" ? message["subtype"] : null;

  switch (type) {
    case "system":
      if (subtype === "init") {
        return [
          {
            kind: "init",
            sessionId: str(message["session_id"]),
            model: str(message["model"]),
            claudeCodeVersion: str(message["claude_code_version"]),
            tools: arr(message["tools"]).filter((t): t is string => typeof t === "string"),
            mcpServers: arr(message["mcp_servers"])
              .filter(isObject)
              .map((s) => ({ name: str(s["name"]), status: str(s["status"]) })),
          },
        ];
      }
      if (subtype === "api_retry") {
        return [
          {
            kind: "api_retry",
            attempt: num(message["attempt"]),
            error: str(message["error"], "unknown"),
            errorStatus:
              typeof message["error_status"] === "number" ? message["error_status"] : null,
          },
        ];
      }
      return [{ kind: "unknown", type, subtype }];

    case "assistant": {
      // Nachrichten von Subagenten werden ignoriert; Subagenten sind abgeschaltet (E32).
      if (message["parent_tool_use_id"] !== null && message["parent_tool_use_id"] !== undefined) {
        return [];
      }
      const events: RunEvent[] = [];
      if (typeof message["error"] === "string") {
        events.push({ kind: "assistant_error", error: message["error"] });
      }
      const inner = isObject(message["message"]) ? message["message"] : {};
      for (const block of arr(inner["content"])) {
        if (!isObject(block)) {
          continue;
        }
        if (block["type"] === "text") {
          events.push({ kind: "text", text: str(block["text"]) });
        } else if (block["type"] === "thinking") {
          events.push({ kind: "thinking", text: str(block["thinking"]) });
        } else if (block["type"] === "tool_use") {
          events.push({
            kind: "tool_use",
            id: str(block["id"]),
            name: str(block["name"]),
            input: block["input"],
          });
        }
      }
      return events;
    }

    case "user": {
      if (message["parent_tool_use_id"] !== null && message["parent_tool_use_id"] !== undefined) {
        return [];
      }
      const inner = isObject(message["message"]) ? message["message"] : {};
      return arr(inner["content"])
        .filter(isObject)
        .filter((block) => block["type"] === "tool_result")
        .map((block) => ({
          kind: "tool_result" as const,
          toolUseId: str(block["tool_use_id"]),
          isError: block["is_error"] === true,
          content: truncate(toolResultText(block["content"]), MAX_TOOL_RESULT_CHARS),
        }));
    }

    case "rate_limit_event": {
      const info = isObject(message["rate_limit_info"]) ? message["rate_limit_info"] : {};
      return [
        {
          kind: "rate_limit",
          status: rateStatus(info["status"]),
          resetsAt: typeof info["resetsAt"] === "number" ? info["resetsAt"] : null,
          utilization: typeof info["utilization"] === "number" ? info["utilization"] : null,
        },
      ];
    }

    case "result":
      return [
        {
          kind: "result",
          subtype: subtype ?? "unknown",
          isError: message["is_error"] === true || (subtype !== null && subtype !== "success"),
          text: typeof message["result"] === "string" ? message["result"] : null,
          errors: arr(message["errors"]).filter((e): e is string => typeof e === "string"),
          numTurns: num(message["num_turns"]),
          durationMs: num(message["duration_ms"]),
          totalCostUsd: num(message["total_cost_usd"]),
          usage: usageFrom(message["usage"]),
          modelUsage: modelUsageFrom(message["modelUsage"]),
          permissionDenials: arr(message["permission_denials"]).length,
        },
      ];

    default:
      return [{ kind: "unknown", type, subtype }];
  }
}

/** Zerlegt einen Datenstrom in Zeilen, auch wenn Blöcke mitten in einer Zeile enden. */
export class LineSplitter {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines;
  }

  end(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest === "" ? [] : [rest];
  }
}
