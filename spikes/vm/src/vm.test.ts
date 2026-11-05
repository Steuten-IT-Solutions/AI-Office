import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../../../packages/office/src/api/tools.ts";
import { mask, Report } from "./bericht.ts";
import { buildArgs, childEnv } from "./claude.ts";
import { buildAllowlist, normalizePath, parseLog, type LogEntry } from "./endpunkte.ts";
import { handle, officeTools } from "./mcp-attrappe.ts";
import { checkControls, evaluateRun, isNamespaceId, parseProbe, probeCommand } from "./s1a.ts";
import { interpretCurl, missingSteps } from "./s1b.ts";
import {
  anythingLoaded,
  buildReport as s1fReport,
  fixture,
  missingChannels,
  observe,
  ran,
} from "./s1f.ts";
import { verdict } from "./s1g.ts";
import {
  buildReport as s2Report,
  officeGaps,
  officePrompt,
  parseOutput,
  resultOf,
  sampleGaps,
  type Block,
  type Results,
  type Snapshot,
} from "./s2.ts";
import { factor, median, quantile, stability } from "./statistik.ts";
import { summarize, succeeded } from "./stream.ts";
import {
  delta,
  findStructuredRows,
  findTextRows,
  resetKinds,
  usageRows,
  weeklyKind,
} from "./usage.ts";

// Kein Test ruft das CLI oder ein LLM auf (E23). Die stream-json-Zeilen sind von Hand gebaut.
const STREAM = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    model: "claude-haiku",
    claude_code_version: "2.1.312",
    tools: ["Bash", "Read"],
    mcp_servers: [{ name: "fremd", status: "connected" }],
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bash /x.sh" } }],
    },
  }),
  JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } }),
  JSON.stringify({ type: "system", subtype: "neu" }),
  "keine json-zeile",
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "FERTIG",
    total_cost_usd: 0.0123,
    num_turns: 2,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
    },
  }),
].join("\n");

describe("Bericht", () => {
  it("maskiert token-ähnliche Zeichenfolgen überall", () => {
    // Zur Laufzeit zusammengesetzt, damit der Secret-Scan keine Attrappe meldet.
    const fake = (kind: string, rest: string) => ["sk", "ant", kind, rest].join("-");
    const report = new Report("T", [`Kontext ${fake("oat01", "geheim")}`]);
    report.add("Prüfung", "x", `sah ${fake("api03", "abc_DEF-123")}`, true);
    report.section("A", [fake("oat01", "zzz")]);
    const md = report.toMarkdown(new Date(0));
    expect(md).not.toMatch(/sk-ant-(?!\*\*\*)/);
    expect(mask(`a ${fake("oat01", "x1")} b`)).toBe("a sk-ant-*** b");
  });

  it("wertet ungültige Kontrollen vor Abweichungen", () => {
    const report = new Report("T");
    report.add("a", "x", "y", false);
    expect(report.outcome).toMatch(/^No-Go/);
    report.invalid("k", "x", "y");
    expect(report.outcome).toMatch(/^Ungültig/);
  });

  it("meldet kein Go, wenn keine Prüfung bewertet wurde", () => {
    const report = new Report("T");
    expect(report.outcome).toMatch(/^Nicht bewertbar/);
    report.add("nur Information", "x", "y", null);
    expect(report.outcome).toMatch(/^Nicht bewertbar/);
    report.add("Prüfung", "x", "x", true);
    expect(report.outcome).toMatch(/^Go/);
  });
});

describe("CLI-Aufruf", () => {
  it("baut die Flags aus plan.md 5.7", () => {
    const args = buildArgs({
      prompt: "Hallo",
      model: "haiku",
      maxTurns: 3,
      maxBudgetUsd: 0.05,
      allowedTools: ["Bash(bash /opt/x.sh probe)", "Read"],
      cwd: "/work",
    });
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "haiku",
      "--max-turns",
      "3",
      "--max-budget-usd",
      "0.05",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--allowedTools",
      "Bash(bash /opt/x.sh probe)",
      "Read",
      "--setting-sources",
      "user",
      "--settings",
      '{"disableAllHooks":true}',
      "--",
      "Hallo",
    ]);
  });

  it("lässt Flags für die Kontrolle weg", () => {
    const args = buildArgs({
      prompt: "x",
      model: "haiku",
      maxTurns: 1,
      maxBudgetUsd: 0.01,
      allowedTools: [],
      settingSources: null,
      settings: null,
      cwd: "/",
    });
    expect(args).not.toContain("--setting-sources");
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--allowedTools");
  });

  it("entfernt Variablen aus der Umgebung des Kindprozesses", () => {
    const env = childEnv(
      { A: "1", CLAUDE_CODE_OAUTH_TOKEN: "t" },
      { CLAUDE_CODE_OAUTH_TOKEN: undefined, B: "2" },
    );
    expect(env).toEqual({ A: "1", B: "2" });
  });
});

describe("stream-json", () => {
  it("fasst einen Lauf mit dem Parser des Office zusammen", () => {
    const s = summarize(STREAM);
    expect(s.model).toBe("claude-haiku");
    expect(s.claudeCodeVersion).toBe("2.1.312");
    expect(s.mcpServers).toEqual([{ name: "fremd", status: "connected" }]);
    expect(s.toolUses).toEqual([{ name: "Bash", command: "bash /x.sh" }]);
    expect(s.rateLimits.map((r) => r.status)).toEqual(["allowed_warning"]);
    expect(s.eventCounts["unbekannt:system/neu"]).toBe(1);
    expect(s.invalidLines).toBe(1);
    expect(s.totalCostUsd).toBe(0.0123);
    expect(s.usage?.cacheReadInputTokens).toBe(100);
    expect(succeeded(s)).toBe(true);
  });
});

describe("S1a", () => {
  const probe = (env: string, ns = "user:[1]") =>
    parseProbe(
      [
        `env\tja\t${env}\t0`,
        "proc_environ\t3/5\tnein\t0",
        "proc_cmdline\t5/5\tnein\t0",
        "dateien\t4\tnein\t0",
        `info\tns_user\t${ns}`,
        "ende\tok",
      ].join("\n"),
    );

  it("liest die Ausgabe der Probe", () => {
    const p = probe("ja");
    expect(p.complete).toBe(true);
    expect(p.rows["env"]).toEqual({ lesbar: "ja", treffer: "ja", aehnlich: 0 });
    expect(p.info["ns_user"]).toBe("user:[1]");
  });

  it("macht die Messung ungültig, wenn die Positivkontrolle nichts findet", () => {
    const report = new Report("T");
    expect(checkControls(report, probe("nein"), probe("nein"))).toBe(false);
    expect(report.outcome).toMatch(/^Ungültig/);
  });

  it("verlangt genau den Probe-Aufruf, eine eigene Sandbox und keinen Fund", () => {
    const run = summarize(
      [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "1",
                name: "Bash",
                input: { command: probeCommand("claude") },
              },
            ],
          },
        }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ].join("\n"),
    );
    const kontrolle = probe("ja", "user:[1]");
    const ok = new Report("T");
    evaluateRun(ok, "claude", run, probe("nein", "user:[2]"), kontrolle, "", true);
    expect(ok.outcome).toMatch(/^Go/);
    const leak = new Report("T");
    evaluateRun(leak, "claude", run, probe("ja", "user:[1]"), kontrolle, "", true);
    expect(leak.findings.filter((f) => f.verdict === "ABWEICHUNG").map((f) => f.test)).toEqual([
      "Sandbox aktiv (eigener User-Namespace)",
      "Token in Umgebung des Bash-Prozesses",
    ]);
  });
});

describe("S1a: Namespace", () => {
  it("vergleicht nur gültige Namespace-Kennungen", () => {
    expect(isNamespaceId("user:[4026531837]")).toBe(true);
    expect(isNamespaceId("?")).toBe(false);
    expect(isNamespaceId(undefined)).toBe(false);
  });
});

describe("S1b", () => {
  it("verlangt die vorgegebenen Werkzeugaufrufe, nicht nur success", () => {
    const empty = summarize(
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    );
    expect(missingSteps("text", empty)).toEqual([]);
    expect(missingSteps("werkzeuge", empty)).toHaveLength(2);
    expect(missingSteps("mcp", empty)).toEqual([
      "MCP-Server attrappe verbunden",
      "Aufruf mcp__attrappe__ping",
    ]);
  });

  it("normalisiert Pfade wie das Addon des Proxys", () => {
    expect(normalizePath("/v1/messages?beta=true")).toBe("/v1/messages");
    expect(normalizePath("/api/oauth/profile")).toBe("/api/oauth/profile");
    expect(normalizePath("/v1/sessions/0f8e5d2a-1234-4abc-9def-001122334455/events")).toBe(
      "/v1/sessions/*/events",
    );
    expect(normalizePath("/v1/files/123")).toBe("/v1/files/*");
    expect(normalizePath("/api/x/abcdefghijklmnopqrstuvwxyz012")).toBe("/api/x/*");
    expect(normalizePath("/")).toBe("/");
  });

  it("baut die Allowlist ohne fremde Anmeldung", () => {
    const e = (pfad: string, auth: LogEntry["auth"]): string =>
      JSON.stringify({
        modus: "protokoll",
        methode: "POST",
        host: "api.anthropic.com",
        pfad,
        auth,
        entscheidung: "weitergeleitet",
      });
    const log = parseLog(
      [
        e("/v1/messages", "unser"),
        e("/v1/messages", "keins"),
        e("/v1/x", "fremd"),
        e("/api/hello", "keins"),
        "kaputt",
      ].join("\n"),
    );
    expect(buildAllowlist(log)).toEqual([
      {
        methode: "POST",
        host: "api.anthropic.com",
        pfad: "/api/hello",
        auth: ["keins"],
        anzahl: 1,
      },
      {
        methode: "POST",
        host: "api.anthropic.com",
        pfad: "/v1/messages",
        auth: ["unser"],
        anzahl: 2,
      },
    ]);
  });

  it("erkennt Blockaden des Proxys in der curl-Ausgabe", () => {
    expect(
      interpretCurl("HTTP/1.1 403 Forbidden\nx-aio-proxy: blockiert\n\n403 000", 0),
    ).toMatchObject({
      blockedByProxy: true,
      status: "403",
    });
    expect(interpretCurl("HTTP/1.1 403 Forbidden\n\n000 403", 56)).toMatchObject({
      blockedByProxy: true,
      status: "CONNECT 403",
    });
    expect(interpretCurl("HTTP/1.1 401 Unauthorized\n\n401 200", 0).blockedByProxy).toBe(false);
  });
});

describe("S1f", () => {
  it("legt Hooks und fremden MCP-Server mit absoluten Markerpfaden an", () => {
    const files = fixture("/work/plan");
    const settings = JSON.parse(files[".claude/settings.json"] ?? "{}") as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(settings.hooks["SessionStart"]?.[0]?.hooks[0]?.command).toBe(
      "touch /work/plan/MARKER-hook-SessionStart",
    );
    expect(files[".mcp.json"]).toContain("/work/plan/MARKER-mcp");
  });

  it("wertet Markerdateien und system/init aus", () => {
    const dir = mkdtempSync(join(tmpdir(), "s1f-"));
    const empty = summarize("");
    expect(anythingLoaded(observe(dir, empty))).toBe(false);
    writeFileSync(join(dir, "MARKER-hook-Stop"), "");
    expect(observe(dir, empty).hooks).toEqual(["Stop"]);
    const withMcp = summarize(STREAM);
    expect(observe(mkdtempSync(join(tmpdir(), "s1f-")), withMcp).mcpInInit).toBe(true);
  });

  it("verlangt in der Kontrolle jeden Kanal und in der Plan-Variante einen echten Lauf", () => {
    const o = {
      hooks: ["Stop"],
      bash: false,
      mcpStarted: false,
      mcpInInit: false,
      claudeMd: false,
    };
    expect(missingChannels(o)).toEqual(["Bash-Freigabe", "MCP"]);
    expect(missingChannels({ ...o, bash: true, mcpInInit: true })).toEqual([]);
    expect(ran(summarize(""))).toBe(false);
    expect(ran(summarize(STREAM))).toBe(true);

    // Kontrolle zeigt alle Kanäle, Plan-Lauf fehlt: ungültig statt Go.
    const dir = mkdtempSync(join(tmpdir(), "s1f-"));
    mkdirSync(join(dir, "kontrolle"));
    for (const marker of ["MARKER-hook-Stop", "MARKER-bash", "MARKER-mcp"]) {
      writeFileSync(join(dir, "kontrolle", marker), "");
    }
    writeFileSync(join(dir, "lauf-kontrolle.jsonl"), STREAM);
    const report = s1fReport(dir, []);
    expect(report.findings.find((f) => f.test.startsWith("Flags aus plan.md"))?.verdict).toBe(
      "ungültig",
    );
    writeFileSync(join(dir, "lauf-plan.jsonl"), STREAM.replace('"fremd"', '"office"'));
    expect(
      s1fReport(dir, []).findings.find((f) => f.test.startsWith("Flags aus plan.md"))?.verdict,
    ).toBe("erwartet");
  });
});

describe("S1g", () => {
  it("bewertet Erreichbarkeit gegen die Erwartung", () => {
    const base = { name: "x", detail: "", infoOnly: false };
    expect(verdict({ ...base, expect: "scheitert", reached: false })).toBe(true);
    expect(verdict({ ...base, expect: "scheitert", reached: true })).toBe(false);
    expect(verdict({ ...base, expect: "geht", reached: true })).toBe(true);
    expect(verdict({ ...base, expect: "geht", reached: false, infoOnly: true })).toBeNull();
  });
});

describe("S2: /usage lesen", () => {
  it("findet strukturierte Fenster im SDKUsageReport-Format aus Fakt 7", () => {
    const rows = findStructuredRows({
      type: "usage_report",
      rows: [
        { kind: "session", percent: 12, resets_at: "2026-11-05T20:00:00Z" },
        { kind: "weekly_all", percent: 34.5, resets_at: "2026-11-09T00:00:00Z" },
      ],
    });
    expect(rows.map((r) => [r.kind, r.percent, r.resetsAt])).toEqual([
      ["session", 12, "2026-11-05T20:00:00Z"],
      ["weekly_all", 34.5, "2026-11-09T00:00:00Z"],
    ]);
    expect(weeklyKind(rows)).toBe("weekly_all");
  });

  it("liest Fenster aus dem Text, wenn es keine Struktur gibt", () => {
    const rows = findTextRows(
      [
        "Current session",
        "████░░░░ 12% used",
        "Resets 9pm (Europe/Berlin)",
        "Current week (all models): 34 %",
        "Current week (Sonnet only)  5,5% used",
      ].join("\n"),
    );
    expect(rows.map((r) => [r.kind, r.percent])).toEqual([
      ["current_session", 12],
      ["current_week_all_models", 34],
      ["current_week_sonnet_only", 5.5],
    ]);
    expect(rows[0]?.resetsAt).toBe("Resets 9pm (Europe/Berlin)");
    expect(weeklyKind(rows)).toBe("current_week_all_models");
  });

  it("ignoriert rate_limit_event und nimmt Struktur vor Text", () => {
    const messages = [
      { type: "rate_limit_event", rate_limit_info: { type: "five_hour", utilization: 0.5 } },
      { type: "result", result: "Session 3%" },
    ];
    expect(usageRows(messages, "Session 3%").map((r) => r.source)).toEqual(["text"]);
  });

  it("rechnet Differenzen je Fenster", () => {
    const row = (kind: string, percent: number) => ({ kind, percent, resetsAt: null, source: "t" });
    expect(delta([row("a", 10), row("b", 5)], [row("a", 12.5), row("c", 1)])).toEqual({ a: 2.5 });
  });

  it("liest json- und stream-json-Ausgaben", () => {
    expect(resultOf(parseOutput('{"type":"result","result":"x"}'))).toEqual({
      type: "result",
      result: "x",
    });
    expect(parseOutput('{"type":"a"}\n{"type":"result"}\nkaputt')).toHaveLength(2);
  });
});

describe("S2: Statistik", () => {
  it("rechnet Quantile wie Typ 7", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1);
  });

  it("prüft das Go-Kriterium 90-%-Quantil / Median ≤ 1,5", () => {
    expect(stability([10, 10, 11, 12, 10, 11]).go).toBe(true);
    expect(stability([10, 10, 10, 10, 30, 40]).go).toBe(false);
    expect(stability([0, 0, 0]).ratio).toBeNull();
    expect(factor(1, 0)).toBeNull();
  });
});

describe("MCP-Attrappe", () => {
  it("bietet die fünf Werkzeuge der Office-API und drei Platzhalter", () => {
    const names = officeTools().map((t) => t.name);
    expect(names).toHaveLength(8);
    expect(names.slice(0, 5)).toEqual(TOOLS.map((t) => t.name));
  });

  it("beantwortet initialize, server/discover, tools/list und tools/call", () => {
    const tools = officeTools();
    const answer = (line: string) =>
      JSON.parse(handle(line, tools, "office") ?? "null") as Record<string, unknown>;
    expect(
      answer(
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}',
      ),
    ).toMatchObject({
      result: { protocolVersion: "2025-11-25" },
    });
    expect(answer('{"jsonrpc":"2.0","id":2,"method":"server/discover"}')).toMatchObject({
      result: { supportedVersions: ["2026-07-28"] },
    });
    expect(
      answer('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_task"}}'),
    ).toMatchObject({
      result: { isError: false },
    });
    expect(
      answer('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"gibtsnicht"}}'),
    ).toMatchObject({
      error: { code: -32602 },
    });
    expect(
      handle('{"jsonrpc":"2.0","method":"notifications/initialized"}', tools, "office"),
    ).toBeNull();
  });
});

describe("S2c: Stichprobe", () => {
  const snapshot = (percent: number): Snapshot => ({
    zeit: "",
    methode: "json",
    zugang: "voll",
    rows: [{ kind: "weekly_all", percent, resetsAt: null, source: "json" }],
    costUsd: 0,
    isError: false,
    exitCode: 0,
    text: "",
    stderr: "",
  });
  const block = (model: string, index: number, runs: number): Block => ({
    model,
    index,
    before: snapshot(index),
    after: snapshot(index + 1),
    runs: Array.from({ length: runs }, () => ({
      model,
      subtype: "success",
      costUsd: 0.1,
      usage: null,
      eventCounts: {},
      rateLimits: [],
    })),
    costUsd: runs * 0.1,
    delta: { weekly_all: 1 },
  });

  it("gibt bei unvollständiger Stichprobe kein Go", () => {
    const c: NonNullable<Results["c"]> = {
      blocks: [block("haiku", 1, 2)],
      abbruch: "Budget erreicht",
      budgetPp: 5,
      start: snapshot(0),
      geplant: { bloecke: 2, laeufeJeBlock: 2 },
    };
    expect(sampleGaps(c, "haiku")).toContain("1 von 2 Blöcken");
    expect(sampleGaps(c, "sonnet")).toContain("0 von 2 Blöcken");
    expect(s2Report({ c }, []).outcome).toMatch(/^Ungültig/);

    const full = {
      ...c,
      abbruch: null,
      blocks: [1, 2].flatMap((i) => ["haiku", "sonnet"].map((m) => block(m, i, 2))),
    };
    expect(sampleGaps(full, "haiku")).toBeNull();
    expect(s2Report({ c: full }, []).outcome).toMatch(/^Go/);
  });
});

describe("S2: Reset und Grundkosten", () => {
  const row = (kind: string, percent: number, resetsAt: string | null, source = "$") => ({
    kind,
    percent,
    resetsAt,
    source,
  });

  it("erkennt zurückgesetzte Fenster", () => {
    expect(resetKinds([row("weekly_all", 80, "a")], [row("weekly_all", 1, "a")])).toEqual([
      "weekly_all",
    ]);
    expect(resetKinds([row("weekly_all", 10, "a")], [row("weekly_all", 12, "b")])).toEqual([
      "weekly_all",
    ]);
    expect(resetKinds([row("w", 10, "in 3 h", "text")], [row("w", 11, "in 2 h", "text")])).toEqual(
      [],
    );
  });

  it("verlangt für S2d einen verbundenen Office-Server mit allen Werkzeugen", () => {
    const gaps = officeGaps(summarize(STREAM), officeTools());
    expect(gaps).toContain("MCP-Server office nicht verbunden");
    expect(gaps.some((g) => g.startsWith("Werkzeuge fehlen"))).toBe(true);
  });

  it("wertet S2a ohne Wert aus claude.ai und S2b ohne Kosten als ungültig", () => {
    const snap: Snapshot = {
      zeit: "",
      methode: "json",
      zugang: "voll",
      rows: [row("weekly_all", 10, null)],
      costUsd: 0,
      isError: false,
      exitCode: 0,
      text: "",
      stderr: "",
    };
    const a = s2Report({ a: { snapshots: [snap], vergleich: {}, methode: "json" } }, []);
    expect(a.findings.find((f) => f.test.includes("Vergleich"))?.verdict).toBe("ungültig");
    const b = s2Report({ b: { before: snap, after: snap, costs: [null, 0], errors: 0 } }, []);
    expect(b.findings.find((f) => f.test.includes("total_cost_usd"))?.verdict).toBe("ungültig");
    expect(b.findings.find((f) => f.test.includes("Anstieg"))?.verdict).toBe("erwartet");
  });
});

describe("S2d", () => {
  it("nimmt die Verfassung aus plan.md 4.1 in den System-Prompt", () => {
    const prompt = officePrompt("# Plan\n### 4.1 Verfassung (x)\n1. Regel\n### 4.2 Weiter\nnicht");
    expect(prompt).toContain("1. Regel");
    expect(prompt).not.toContain("nicht");
  });
});
