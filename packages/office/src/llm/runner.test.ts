import { describe, expect, it } from "vitest";
import { FakeRunner, loadFixture } from "./fake-runner.ts";
import type { RunRequest } from "./runner.ts";
import { LineSplitter, MAX_TOOL_RESULT_CHARS, parseLine, type RunEvent } from "./stream-json.ts";

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: "r-test",
    agentId: "coo",
    runType: "buero",
    model: "sonnet",
    prompt: "Bitte übernehmen.",
    maxTurns: 5,
    maxBudgetUsd: 0.5,
    ...overrides,
  };
}

async function play(fixture: string, chunkSize?: number) {
  const events: RunEvent[] = [];
  const runner = new FakeRunner({
    select: () => fixture,
    ...(chunkSize === undefined ? {} : { chunkSize }),
  });
  const outcome = await runner.run(request(), { onEvent: (e) => events.push(e) });
  return { events, outcome, runner };
}

describe("parseLine", () => {
  it("ignoriert Leerzeilen und meldet unlesbare Zeilen", () => {
    expect(parseLine("   ")).toEqual([]);
    expect(parseLine("{kaputt")).toEqual([{ kind: "invalid", excerpt: "{kaputt" }]);
    expect(parseLine("[1,2]")).toMatchObject([{ kind: "invalid" }]);
  });

  it("meldet unbekannte Nachrichtentypen, ohne abzubrechen", () => {
    expect(parseLine('{"type":"system","subtype":"hook_started"}')).toEqual([
      { kind: "unknown", type: "system", subtype: "hook_started" },
    ]);
    expect(parseLine('{"type":"neu_in_v3"}')).toEqual([
      { kind: "unknown", type: "neu_in_v3", subtype: null },
    ]);
  });

  it("kürzt lange Werkzeugergebnisse", () => {
    const long = "x".repeat(MAX_TOOL_RESULT_CHARS + 100);
    const [event] = parseLine(
      JSON.stringify({
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "t", content: long }] },
      }),
    );
    expect(event?.kind).toBe("tool_result");
    if (event?.kind === "tool_result") {
      expect(event.content.length).toBeLessThan(long.length);
      expect(event.content).toContain("gekürzt");
    }
  });

  it("behandelt eine Ergebnisnachricht mit Fehler-Untertyp als Fehler", () => {
    const [event] = parseLine('{"type":"result","subtype":"error_max_turns","is_error":false}');
    expect(event).toMatchObject({ kind: "result", isError: true, subtype: "error_max_turns" });
  });
});

describe("LineSplitter", () => {
  it("setzt Zeilen über Blockgrenzen hinweg zusammen", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":')).toEqual([]);
    expect(splitter.push('1}\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(":2}\n")).toEqual(['{"b":2}']);
    expect(splitter.end()).toEqual([]);
  });
});

describe("FakeRunner", () => {
  it("spielt einen erfolgreichen Lauf ab", async () => {
    const { events, outcome, runner } = await play("buero-erfolg");
    expect(runner.requests).toHaveLength(1);
    expect(events.map((e) => e.kind)).toEqual(["init", "text", "rate_limit", "result"]);
    expect(outcome).toMatchObject({
      runId: "r-test",
      exit: "completed",
      resultSubtype: "success",
      totalCostUsd: 0.0412,
      numTurns: 1,
      rateLimitStatus: "allowed",
      invalidLines: 0,
    });
    expect(outcome.usage.cacheCreationInputTokens).toBe(8000);
  });

  it("liefert Werkzeugaufrufe und ignoriert Subagenten", async () => {
    const { events, outcome } = await play("werkbank-werkzeug");
    expect(events.map((e) => e.kind)).toEqual([
      "init",
      "thinking",
      "tool_use",
      "tool_result",
      "text",
      "result",
    ]);
    expect(events.some((e) => e.kind === "text" && e.text.includes("Subagent"))).toBe(false);
    expect(events.find((e) => e.kind === "tool_use")).toMatchObject({
      name: "Bash",
      input: { command: "pnpm test" },
    });
    expect(Object.keys(outcome.modelUsage).sort()).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
    ]);
  });

  it("meldet Budgetabbruch, Warnung zum Kontingent und Wiederholung", async () => {
    const { events, outcome } = await play("budget-ueberschritten");
    expect(events.find((e) => e.kind === "api_retry")).toMatchObject({
      error: "overloaded",
      errorStatus: 529,
    });
    expect(outcome).toMatchObject({
      exit: "error",
      resultSubtype: "error_max_budget_usd",
      rateLimitStatus: "allowed_warning",
    });
    const result = events.find((e) => e.kind === "result");
    expect(result).toMatchObject({
      permissionDenials: 1,
      errors: ["Budget von 0.50 USD überschritten"],
    });
  });

  it("erkennt einen Lauf ohne Ergebnisnachricht", async () => {
    const { outcome } = await play("abgestuerzt");
    expect(outcome.exit).toBe("no_result");
    expect(outcome.invalidLines).toBe(1);
    expect(outcome.totalCostUsd).toBe(0);
  });

  it("liefert dasselbe Ergebnis unabhängig von der Blockgröße", async () => {
    const whole = await play("werkbank-werkzeug");
    const chunked = await play("werkbank-werkzeug", 7);
    expect(chunked.events).toEqual(whole.events);
    expect(chunked.outcome).toEqual(whole.outcome);
  });

  it("bricht über das AbortSignal ab", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new FakeRunner({ select: () => "buero-erfolg" });
    const outcome = await runner.run(request(), { signal: controller.signal });
    expect(outcome.exit).toBe("aborted");
  });

  it("wählt die Aufzeichnung je Auftrag", async () => {
    const runner = new FakeRunner({
      select: (r) => (r.runType === "werkbank" ? "werkbank-werkzeug" : "buero-erfolg"),
    });
    const outcome = await runner.run(request({ runType: "werkbank" }));
    expect(outcome.finalText).toBe("Alle Tests sind grün.");
  });

  it("lehnt Fixture-Namen mit Pfadanteilen ab", () => {
    expect(() => loadFixture("../package")).toThrow(/Ungültiger/);
  });
});
