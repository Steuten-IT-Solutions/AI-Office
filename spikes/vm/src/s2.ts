/**
 * Spike S2: Kontingent (docs/etappe-0.md 3.2, plan.md Kap. 6, Fakt 5–7).
 *
 * Läuft in einem Lauf-Container mit beiden Zugängen:
 *  - voller Login in /claude-voll (CLAUDE_CONFIG_DIR) nur für `/usage`,
 *  - setup-token in CLAUDE_CODE_OAUTH_TOKEN für die Läufe (wie später im Büro).
 * Der Zähler ist zwischen Ihrer Nutzung und dem Büro geteilt (Fakt 5): Während S2b und S2c
 * dürfen Sie Claude nicht nutzen.
 *
 *   node s2.ts teil a|b|c|d     einzelne Teile (Ergebnisse in /work/s2-ergebnis.json)
 *   node s2.ts alles            a, b, c, d nacheinander
 *   node s2.ts bericht [kontextdatei]
 *
 * Umgebung: AIO_S2_BUDGET_PP (Standard 5, Abbruch ab diesem Anstieg des Wochenzählers),
 * AIO_S2_BLOECKE (Standard 6 je Modell), AIO_S2_LAEUFE_JE_BLOCK (Standard 5).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { mask, Report } from "./bericht.ts";
import { describe, runClaude, spawnClaude, type ClaudeRun } from "./claude.ts";
import { isMain } from "./cli.ts";
import { officeTools } from "./mcp-attrappe.ts";
import { ATTRAPPE } from "./s1b.ts";
import { stability, factor, median } from "./statistik.ts";
import { isObject, type RunSummary } from "./stream.ts";
import { delta, resetKinds, usageRows, weeklyKind, type UsageRow } from "./usage.ts";

const WORK = "/work";
const RESULT_FILE = join(WORK, "s2-ergebnis.json");
const VOLL_ENV = { CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CONFIG_DIR: "/claude-voll" };

export type Method = "json" | "stream";

export interface Snapshot {
  zeit: string;
  methode: Method;
  zugang: "voll" | "token";
  rows: UsageRow[];
  costUsd: number | null;
  isError: boolean | null;
  exitCode: number | null;
  /** Ergebnistext von /usage, maskiert und gekürzt (zum Nachbauen des Parsers). */
  text: string;
  stderr: string;
}

export interface RunRecord {
  model: string;
  subtype: string | null;
  costUsd: number | null;
  usage: RunSummary["usage"];
  eventCounts: Record<string, number>;
  rateLimits: RunSummary["rateLimits"];
  /** S2c/S2d: Was am Lauf fehlt (leer = gültig); fehlt das Feld, wurde es nicht geprüft. */
  mangel?: string[];
}

export interface Block {
  model: string;
  index: number;
  before: Snapshot;
  after: Snapshot;
  runs: RunRecord[];
  costUsd: number;
  delta: Record<string, number>;
}

export interface Results {
  a?: { snapshots: Snapshot[]; vergleich: Record<string, number | null>; methode: Method | null };
  b?: {
    before: Snapshot;
    after: Snapshot;
    costs: (number | null)[];
    errors: number;
    abbruch?: string | null;
  };
  c?: {
    blocks: Block[];
    abbruch: string | null;
    budgetPp: number;
    start: Snapshot;
    /** Geplanter Umfang; nur vollständige Stichproben ergeben ein Go. */
    geplant: { bloecke: number; laeufeJeBlock: number };
  };
  d?: { runs: RunRecord[]; abbruch?: string | null };
  /**
   * Gemeinsame Basis für das Budget aller Teile: erste lesbare Messung in S2a. So zählt auch, was
   * S2a und S2b womöglich verbrauchen (genau das untersucht S2b).
   */
  budgetStart?: Snapshot;
}

function load(): Results {
  return existsSync(RESULT_FILE) ? (JSON.parse(readFileSync(RESULT_FILE, "utf8")) as Results) : {};
}

function save(results: Results): void {
  writeFileSync(RESULT_FILE, JSON.stringify(results, null, 2));
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Messages aus der Ausgabe: ein Objekt (`json`) oder eines je Zeile (`stream`). */
export function parseOutput(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  try {
    return [JSON.parse(trimmed) as unknown];
  } catch {
    return trimmed
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
  }
}

export function resultOf(messages: unknown[]): Record<string, unknown> | null {
  for (const m of [...messages].reverse()) {
    if (isObject(m) && m["type"] === "result") {
      return m;
    }
  }
  return null;
}

/** `/usage` abfragen. Ob das im Print-Modus geht, ist genau die Frage von S2a. */
export async function query(method: Method, access: "voll" | "token"): Promise<Snapshot> {
  const args =
    method === "json"
      ? ["-p", "--output-format", "json", "--", "/usage"]
      : ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  const stdin =
    method === "stream"
      ? `${JSON.stringify({ type: "user", message: { role: "user", content: "/usage" } })}\n`
      : "";
  const env = access === "voll" ? VOLL_ENV : { CLAUDE_CONFIG_DIR: "/home/agent/.claude-token" };
  if (access === "token") {
    mkdirSync("/home/agent/.claude-token", { recursive: true });
  }
  const raw = await spawnClaude(args, { cwd: WORK, env, stdin, timeoutMs: 120_000 });
  const messages = parseOutput(raw.stdout);
  const result = resultOf(messages);
  const text = typeof result?.["result"] === "string" ? result["result"] : "";
  return {
    zeit: new Date().toISOString(),
    methode: method,
    zugang: access,
    rows: usageRows(messages, text),
    costUsd: typeof result?.["total_cost_usd"] === "number" ? result["total_cost_usd"] : null,
    isError: typeof result?.["is_error"] === "boolean" ? result["is_error"] : null,
    exitCode: raw.exitCode,
    text: mask(text).slice(0, 3000),
    stderr: raw.stderr.split("\n")[0] ?? "",
  };
}

function show(s: Snapshot): string {
  const rows = s.rows.map((r) => `${r.kind}=${String(r.percent)} %`).join(", ");
  return `${s.methode}/${s.zugang}: ${rows || "keine Werte"} (Kosten ${String(s.costUsd ?? "?")} USD${s.isError === true ? ", Fehler" : ""})`;
}

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return "";
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function confirmQuiet(): Promise<void> {
  console.log(
    "\nWährend dieses Teils bitte Claude nirgends nutzen (claude.ai, App, Claude Code). Sonst sind die Messungen wertlos (etappe-0.md 3.2).",
  );
  const answer = await ask("Ruhiges Zeitfenster bestätigt? [ja/nein] ");
  if (process.stdin.isTTY && answer !== "ja") {
    throw new Error("Abgebrochen: kein ruhiges Zeitfenster bestätigt");
  }
}

async function teilA(results: Results): Promise<void> {
  console.log("\nS2a: /usage per Skript");
  const snapshots: Snapshot[] = [];
  for (const [method, access] of [
    ["json", "voll"],
    ["stream", "voll"],
    ["json", "token"],
  ] as const) {
    const s = await query(method, access);
    console.log(`  ${show(s)}`);
    snapshots.push(s);
  }
  const usable = snapshots.find((s) => s.zugang === "voll" && s.rows.length > 0) ?? null;
  const vergleich: Record<string, number | null> = {};
  if (usable !== null) {
    console.log(
      "\nBitte jetzt in claude.ai die Nutzungsanzeige öffnen (Einstellungen → Nutzung) und die Werte eingeben.",
    );
    for (const row of usable.rows) {
      const answer = await ask(
        `  Wert in claude.ai für „${row.kind}“ (Skript: ${String(row.percent)} %), leer = überspringen: `,
      );
      const value = Number(answer.replace(",", ".").replace("%", ""));
      vergleich[row.kind] = answer === "" || !Number.isFinite(value) ? null : value;
    }
  }
  results.a = { snapshots, vergleich, methode: usable?.methode ?? null };
  // S2a beginnt den Spike: Die Budget-Basis wird hier neu gesetzt (auch bei einer Wiederholung).
  if (usable === null) {
    delete results.budgetStart;
  } else {
    results.budgetStart = usable;
  }
  save(results);
}

function method(results: Results): Method {
  const m = results.a?.methode ?? null;
  if (m === null) {
    throw new Error(
      "S2a hat keinen Weg gefunden, /usage per Skript zu lesen. S2b und S2c entfallen (Fallback aus Kap. 6).",
    );
  }
  return m;
}

async function teilB(results: Results): Promise<void> {
  console.log("\nS2b: Kostet die Abfrage Kontingent? (30 Abfragen)");
  const m = method(results);
  await confirmQuiet();
  const budgetPp = envNumber("AIO_S2_BUDGET_PP", 5);
  const before = await query(m, "voll");
  const baseline = budgetBaseline(results, before);
  const costs: (number | null)[] = [];
  let errors = 0;
  let after = before;
  let abbruch: string | null = null;
  for (let i = 0; i < 30; i++) {
    // Kostet /usage Kontingent, gilt auch hier das Budget; ohne lesbaren Zähler keine Abfrage mehr.
    abbruch = budgetStop(baseline, after, budgetPp);
    if (abbruch !== null) {
      console.log(`  Abbruch nach ${String(i)} Abfragen: ${abbruch}`);
      break;
    }
    after = await query(m, "voll");
    costs.push(after.costUsd);
    if (after.isError === true || after.rows.length === 0) {
      errors++;
    }
  }
  console.log(`  vorher ${show(before)}\n  nachher ${show(after)}`);
  results.b = { before, after, costs, errors, abbruch };
  save(results);
}

export const STANDARD_FILES: Record<string, string> = {
  "a.txt": "17\n",
  "b.txt": "25\n",
  "c.txt": "58\n",
};

const BUDGET_USD: Record<string, number> = { haiku: 0.1, sonnet: 0.5 };

export function standardRun(model: string, cwd: string): ClaudeRun {
  return {
    prompt:
      "Lies die Dateien a.txt, b.txt und c.txt mit dem Read-Werkzeug. Antworte nur mit der Summe der drei Zahlen.",
    model,
    maxTurns: 6,
    maxBudgetUsd: BUDGET_USD[model] ?? 0.5,
    allowedTools: ["Read"],
    cwd,
  };
}

/** Was einem Standardlauf (S2c) fehlt: drei erfolgreiche Reads, richtige Summe, Messwerte. */
export function standardGaps(summary: RunSummary): string[] {
  const gaps: string[] = [];
  if (summary.resultSubtype !== "success") {
    gaps.push(`Ergebnis ${summary.resultSubtype ?? "fehlt"}`);
  }
  for (const file of Object.keys(STANDARD_FILES)) {
    const read = summary.toolUses.some(
      (t) => t.name === "Read" && (t.filePath === file || (t.filePath ?? "").endsWith(`/${file}`)),
    );
    if (!read) {
      gaps.push(`kein Read von ${file}`);
    }
  }
  if (summary.toolResults.some((r) => r.isError)) {
    gaps.push("Werkzeugfehler");
  }
  if (!/\b100\b/.test(summary.resultText ?? "")) {
    gaps.push("Antwort ohne die Summe 100");
  }
  if (summary.totalCostUsd === null || summary.usage === null) {
    gaps.push("keine Kosten oder Nutzung im Ergebnis");
  }
  return gaps;
}

function record(model: string, summary: RunSummary): RunRecord {
  return {
    model,
    subtype: summary.resultSubtype,
    costUsd: summary.totalCostUsd,
    usage: summary.usage,
    eventCounts: summary.eventCounts,
    rateLimits: summary.rateLimits,
  };
}

async function teilC(results: Results): Promise<void> {
  const m = method(results);
  const budgetPp = envNumber("AIO_S2_BUDGET_PP", 5);
  const blocks = envNumber("AIO_S2_BLOECKE", 6);
  const perBlock = envNumber("AIO_S2_LAEUFE_JE_BLOCK", 5);
  console.log(
    `\nS2c: Faktor USD → Prozentpunkte (${String(blocks)} Blöcke × ${String(perBlock)} Läufe je Modell, Abbruch ab +${String(budgetPp)} Prozentpunkten Woche)`,
  );
  await confirmQuiet();
  const cwd = join(WORK, "s2c");
  mkdirSync(cwd, { recursive: true });
  for (const [file, content] of Object.entries(STANDARD_FILES)) {
    writeFileSync(join(cwd, file), content);
  }
  const start = await query(m, "voll");
  const weekly = weeklyKind(start.rows);
  const c: NonNullable<Results["c"]> = {
    blocks: [],
    abbruch: null,
    budgetPp,
    start,
    geplant: { bloecke: blocks, laeufeJeBlock: perBlock },
  };
  results.c = c;
  // Sofort speichern: Scheitert der Versuch vor dem ersten Block, darf keine alte Stichprobe
  // auf der Platte bleiben und im Bericht als Ergebnis erscheinen.
  save(results);
  // Ohne lesbares Wochenfenster ist das Budget nicht überwachbar: dann kein einziger Lauf.
  const baseline = budgetBaseline(results, start);
  const before =
    weekly === null ? "Wochenfenster nicht lesbar" : budgetStop(baseline, start, budgetPp);
  if (weekly === null || before !== null) {
    c.abbruch = `vor dem ersten Lauf: ${before ?? "Wochenfenster nicht lesbar"}`;
    console.log(`  Abbruch: ${c.abbruch}`);
    save(results);
    return;
  }
  let current = start;
  outer: for (const model of ["haiku", "sonnet"]) {
    for (let index = 1; index <= blocks; index++) {
      const runs: RunRecord[] = [];
      for (let i = 0; i < perBlock; i++) {
        const result = await runClaude({
          ...standardRun(model, cwd),
          rawFile: join(WORK, `s2c-${model}-${String(index)}-${String(i + 1)}.jsonl`),
        });
        console.log(`  ${model} Block ${String(index)} Lauf ${String(i + 1)}: ${describe(result)}`);
        runs.push({ ...record(model, result.summary), mangel: standardGaps(result.summary) });
        if (result.summary.rateLimits.some((r) => r.status === "rejected")) {
          c.abbruch = "rate_limit_event mit Status rejected";
          break;
        }
      }
      const after = await query(m, "voll");
      const cost = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      c.blocks.push({
        model,
        index,
        before: current,
        after,
        runs,
        costUsd: cost,
        delta: delta(current.rows, after.rows),
      });
      current = after;
      save(results);
      console.log(
        `  Block fertig: ${cost.toFixed(4)} USD, Δ ${JSON.stringify(c.blocks.at(-1)?.delta)}`,
      );
      // Ein schon gesetzter Abbruch (rejected) bleibt stehen. budgetStop erkennt auch einen
      // Reset und ein unlesbares Wochenfenster.
      c.abbruch ??= budgetStop(baseline, after, budgetPp);
      if (c.abbruch !== null) {
        console.log(`  Abbruch: ${c.abbruch}`);
        break outer;
      }
    }
  }
  save(results);
}

/** Was einem S2d-Lauf fehlt, damit er als Office-ähnlich zählt (leer = gültig). */
export function officeGaps(summary: RunSummary, tools: { name: string }[]): string[] {
  const gaps: string[] = [];
  if (summary.resultSubtype !== "success") {
    gaps.push(`Ergebnis ${summary.resultSubtype ?? "fehlt"}`);
  }
  if (!summary.mcpServers.some((s) => s.name === "office" && s.status === "connected")) {
    gaps.push("MCP-Server office nicht verbunden");
  }
  const missing = tools
    .map((t) => `mcp__office__${t.name}`)
    .filter((name) => !summary.tools.includes(name));
  if (missing.length > 0) {
    gaps.push(`Werkzeuge fehlen in system/init: ${missing.join(", ")}`);
  }
  if (summary.usage === null || summary.totalCostUsd === null) {
    gaps.push("keine Nutzung oder Kosten im Ergebnis");
  }
  return gaps;
}

export function officePrompt(planMd: string): string {
  const start = planMd.indexOf("### 4.1 Verfassung");
  const end = planMd.indexOf("### 4.2", start);
  const constitution = start === -1 ? "" : planMd.slice(start, end === -1 ? undefined : end).trim();
  return [
    "Du bist ein Agent des AI-Office (Attrappe für Spike S2d). Arbeite nur mit den Werkzeugen des Büros.",
    "",
    constitution,
  ].join("\n");
}

/** Budget-Basis aus S2a; ohne sie (Teil einzeln gestartet) zählt die übergebene Messung. */
function budgetBaseline(results: Results, fallback: Snapshot): Snapshot {
  results.budgetStart ??= fallback;
  return results.budgetStart;
}

/** Grund, keinen weiteren bezahlten Lauf zu starten, oder `null`. */
export function budgetStop(baseline: Snapshot, now: Snapshot, budgetPp: number): string | null {
  const check = budgetUsed(baseline, now);
  if ("unreadable" in check) {
    return `${check.unreadable}, Budget nicht überwachbar`;
  }
  return check.used >= budgetPp
    ? `Budget erreicht: Woche +${String(check.used)} Prozentpunkte`
    : null;
}

/**
 * Prozentpunkte, die die Woche seit der Budget-Basis gestiegen ist, oder ein Grund, warum das nicht
 * lesbar ist. Die 5 Prozentpunkte gelten für den ganzen Spike S2, nicht nur für S2c.
 */
export function budgetUsed(
  start: Snapshot,
  now: Snapshot,
): { used: number } | { unreadable: string } {
  const weekly = weeklyKind(start.rows);
  if (weekly === null || start.isError === true || now.isError === true) {
    return { unreadable: "Wochenfenster nicht lesbar" };
  }
  if (resetKinds(start.rows, now.rows).includes(weekly)) {
    return { unreadable: "Wochenfenster seit der Budget-Basis zurückgesetzt" };
  }
  const used = delta(start.rows, now.rows)[weekly];
  return used === undefined ? { unreadable: "Wochenfenster fehlt in /usage" } : { used };
}

async function teilD(results: Results): Promise<void> {
  console.log("\nS2d: Grundkosten eines Office-ähnlichen Laufs (je Modell 3 Läufe)");
  // Auch S2d zählt zum freigegebenen Budget: ohne lesbaren Zähler oder bei erreichtem Budget
  // keine weiteren bezahlten Läufe.
  const m = method(results);
  const budgetPp = results.c?.budgetPp ?? envNumber("AIO_S2_BUDGET_PP", 5);
  const now = await query(m, "voll");
  const baseline = budgetBaseline(results, now);
  const planMd = readFileSync("/opt/spike/docs/plan.md", "utf8");
  const tools = officeTools();
  const runs: RunRecord[] = [];
  const cwd = join(WORK, "s2d");
  mkdirSync(cwd, { recursive: true });
  let current = now;
  for (const model of ["haiku", "sonnet"]) {
    for (let i = 1; i <= 3; i++) {
      // Vor jedem bezahlten Lauf neu messen.
      const stop = budgetStop(baseline, current, budgetPp);
      if (stop !== null) {
        console.log(`  Abbruch: ${stop}`);
        results.d = { runs, abbruch: stop };
        save(results);
        return;
      }
      const result = await runClaude({
        prompt: "Antworte mit OK.",
        model,
        maxTurns: 2,
        maxBudgetUsd: BUDGET_USD[model] ?? 0.5,
        allowedTools: tools.map((t) => `mcp__office__${t.name}`),
        cwd,
        rawFile: join(WORK, `s2d-${model}-${String(i)}.jsonl`),
        extraArgs: [
          "--append-system-prompt",
          officePrompt(planMd),
          "--mcp-config",
          JSON.stringify({
            mcpServers: {
              office: {
                command: "node",
                args: [ATTRAPPE, "--name", "office", "--werkzeuge", "office"],
              },
            },
          }),
        ],
      });
      console.log(`  ${model} ${String(i)}: ${describe(result)}`);
      runs.push({ ...record(model, result.summary), mangel: officeGaps(result.summary, tools) });
      if (result.summary.rateLimits.some((r) => r.status === "rejected")) {
        results.d = { runs, abbruch: "rate_limit_event mit Status rejected" };
        console.log(`  Abbruch: ${results.d.abbruch ?? ""}`);
        save(results);
        return;
      }
      current = await query(m, "voll");
    }
  }
  results.d = { runs, abbruch: null };
  save(results);
}

/** Was an der geplanten Stichprobe eines Modells fehlt, oder `null`, wenn sie vollständig ist. */
export function sampleGaps(c: NonNullable<Results["c"]>, model: string): string | null {
  const own = c.blocks.filter((bl) => bl.model === model);
  const gaps: string[] = [];
  if (own.length < c.geplant.bloecke) {
    gaps.push(`${String(own.length)} von ${String(c.geplant.bloecke)} Blöcken`);
  }
  const short = own.filter(
    (bl) =>
      bl.runs.length < c.geplant.laeufeJeBlock ||
      bl.runs.some((r) => r.subtype !== "success" || (r.mangel?.length ?? 1) > 0),
  );
  if (short.length > 0) {
    gaps.push(
      `Blöcke mit fehlenden, gescheiterten oder ungültigen Läufen: ${short.map((bl) => String(bl.index)).join(", ")}`,
    );
  }
  const weekly = weeklyKind(c.start.rows);
  const unread = own.filter(
    (bl) =>
      bl.after.isError === true ||
      weekly === null ||
      bl.delta[weekly] === undefined ||
      resetKinds(bl.before.rows, bl.after.rows).includes(weekly),
  );
  if (unread.length > 0) {
    gaps.push(
      `Wochenfenster vor/nach Block ${unread.map((bl) => String(bl.index)).join(", ")} nicht vergleichbar (unlesbar oder zurückgesetzt)`,
    );
  }
  const noCost = own.filter((bl) => bl.costUsd <= 0 || bl.runs.some((r) => r.costUsd === null));
  if (noCost.length > 0) {
    gaps.push(`Blöcke ohne gemessene Kosten: ${noCost.map((bl) => String(bl.index)).join(", ")}`);
  }
  return gaps.length === 0 ? null : gaps.join("; ");
}

function fmt(n: number | null | undefined, digits = 4): string {
  return n === null || n === undefined || Number.isNaN(n) ? "–" : n.toFixed(digits);
}

export function buildReport(results: Results, context: string[]): Report {
  const report = new Report("S2 – Kontingent", context);

  // S2a
  const a = results.a;
  if (a === undefined) {
    report.add("S2a ausgeführt", "ja", "nein", null);
  } else {
    for (const s of a.snapshots) {
      const structured = s.rows.some((r) => r.source !== "text");
      const complete = s.rows.length > 0 && s.rows.every((r) => r.resetsAt !== null);
      const expectation = s.zugang === "token" ? null : structured && complete;
      report.add(
        `S2a: /usage per ${s.methode === "json" ? "claude -p --output-format json" : "stream-json (Protokoll des Agent SDK)"} mit ${s.zugang === "voll" ? "vollem Login" : "setup-token"}`,
        s.zugang === "voll"
          ? "maschinenlesbar: je Fenster kind, percent, resets_at"
          : "kein Bericht (Token hat nur user:inference, Fakt 7)",
        `${s.rows.length === 0 ? "keine Werte" : `${String(s.rows.length)} Fenster, ${structured ? "strukturiert" : "nur aus Text gelesen"}${complete ? "" : ", ohne Reset-Zeit"}`}; Kosten ${String(s.costUsd ?? "?")} USD; Exit ${String(s.exitCode)}${s.stderr === "" ? "" : `; ${s.stderr}`}`,
        expectation,
      );
    }
    const used = a.snapshots.find((s) => s.methode === a.methode && s.zugang === "voll");
    // Das Go-Kriterium verlangt den Abgleich: Jedes gelesene Fenster braucht einen Wert aus
    // claude.ai, sonst ist S2a nicht geprüft.
    for (const row of used?.rows ?? []) {
      const value = a.vergleich[row.kind] ?? null;
      const test = `S2a: Vergleich mit claude.ai (${row.kind})`;
      if (value === null) {
        report.invalid(test, "± 1 Prozentpunkt", "kein Wert aus claude.ai eingegeben");
      } else {
        report.add(
          test,
          "± 1 Prozentpunkt",
          `Skript ${String(row.percent)} %, claude.ai ${String(value)} %`,
          Math.abs(row.percent - value) <= 1,
        );
      }
    }
    report.table(
      "S2a: gelesene Fenster",
      ["Methode", "Zugang", "Fenster", "Prozent", "Reset", "Fundstelle"],
      a.snapshots.flatMap((s) =>
        s.rows.map((r) => [
          s.methode,
          s.zugang,
          r.kind,
          String(r.percent),
          r.resetsAt ?? "–",
          r.source,
        ]),
      ),
    );
    report.section(
      "S2a: Ergebnistext von /usage (gekürzt)",
      a.snapshots.flatMap((s) => [
        `**${s.methode}/${s.zugang}:**`,
        "```",
        s.text || "(leer)",
        "```",
      ]),
    );
  }

  // S2b
  const b = results.b;
  if (b !== undefined && (b.costs.length < 30 || (b.abbruch ?? null) !== null)) {
    report.invalid(
      "S2b: Stichprobe",
      "30 Abfragen",
      `${String(b.costs.length)} Abfragen${(b.abbruch ?? null) === null ? "" : `; Abbruch: ${b.abbruch ?? ""}`}`,
    );
  }
  if (b !== undefined) {
    const d = delta(b.before.rows, b.after.rows);
    const rising = Object.entries(d).filter(([, v]) => v > 0);
    const kindsBefore = b.before.rows
      .map((r) => r.kind)
      .sort()
      .join(",");
    const kindsAfter = b.after.rows
      .map((r) => r.kind)
      .sort()
      .join(",");
    const resets = resetKinds(b.before.rows, b.after.rows);
    const comparable =
      b.before.isError !== true &&
      b.after.isError !== true &&
      b.before.rows.length > 0 &&
      kindsBefore === kindsAfter &&
      resets.length === 0;
    const anstieg = "S2b: 30 Abfragen, Anstieg der Prozentwerte";
    if (comparable) {
      report.add(
        anstieg,
        "kein messbarer Anstieg",
        `Δ ${JSON.stringify(d)}; Fehler ${String(b.errors)}`,
        rising.length === 0 && b.errors === 0,
      );
    } else {
      report.invalid(
        anstieg,
        "Messung vorher und nachher mit denselben Fenstern, ohne Reset",
        `vorher ${kindsBefore || "keine Werte"}, nachher ${kindsAfter || "keine Werte"}${resets.length === 0 ? "" : `; zurückgesetzt: ${resets.join(", ")}`}`,
      );
    }
    const measured = b.costs.filter((c): c is number => c !== null);
    const cost = measured.reduce((sum, c) => sum + c, 0);
    const kosten = "S2b: Σ total_cost_usd der Abfragen";
    if (measured.length === b.costs.length && measured.length > 0) {
      report.add(kosten, "0 oder vernachlässigbar (< 0,01 USD)", `${fmt(cost)} USD`, cost < 0.01);
    } else {
      report.invalid(
        kosten,
        "Kosten für jede Abfrage gemeldet",
        `${String(measured.length)} von ${String(b.costs.length)} Abfragen mit total_cost_usd`,
      );
    }
  }

  // S2c
  const c = results.c;
  if (c !== undefined) {
    const weekly = weeklyKind(c.start.rows);
    const kinds = [...new Set(c.blocks.flatMap((bl) => Object.keys(bl.delta)))].sort();
    const rows: string[][] = [];
    for (const model of ["haiku", "sonnet"]) {
      const own = c.blocks.filter((bl) => bl.model === model);
      const missing = sampleGaps(c, model);
      if (missing !== null) {
        // Unvollständige Stichprobe: Der Faktor wäre zufällig stabil (z. B. ein einziger Block).
        report.invalid(
          `S2c: Faktor ${model}, Stichprobe`,
          `${String(c.geplant.bloecke)} Blöcke × ${String(c.geplant.laeufeJeBlock)} erfolgreiche Läufe`,
          missing,
        );
      }
      if (own.length === 0) {
        continue;
      }
      for (const kind of kinds) {
        const factors = own
          .map((bl) => factor(bl.delta[kind] ?? 0, bl.costUsd))
          .filter((f): f is number => f !== null);
        const st = stability(factors);
        rows.push([
          model,
          kind,
          String(st.blocks),
          fmt(st.median, 2),
          fmt(st.p90, 2),
          st.ratio === null ? "–" : fmt(st.ratio, 2),
        ]);
        if (kind === weekly) {
          const test = `S2c: Faktor ${model}, ${kind} (90-%-Quantil / Median)`;
          if (st.go === null) {
            report.invalid(
              test,
              "≤ 1,5",
              `nicht messbar (Median ${fmt(st.median, 2)}, ${String(st.blocks)} Blöcke)`,
            );
          } else {
            report.add(
              test,
              "≤ 1,5",
              `${fmt(st.ratio, 2)} (Median ${fmt(st.median, 2)} pp/USD, ${String(st.blocks)} Blöcke)`,
              missing === null ? st.go : null,
            );
          }
        }
      }
    }
    report.add("S2c: Abbruch", "keiner", c.abbruch ?? "keiner", c.abbruch === null ? true : null);
    report.table(
      "S2c: Faktor je Modell und Fenster (Prozentpunkte je USD)",
      ["Modell", "Fenster", "Blöcke", "Median", "90-%-Quantil", "Verhältnis"],
      rows,
    );
    report.table(
      "S2c: Blöcke",
      ["Modell", "Block", "Σ USD", "Δ Prozentpunkte", "Läufe ok"],
      c.blocks.map((bl) => [
        bl.model,
        String(bl.index),
        fmt(bl.costUsd),
        JSON.stringify(bl.delta),
        `${String(bl.runs.filter((r) => r.subtype === "success").length)}/${String(bl.runs.length)}`,
      ]),
    );
    const startWeekly =
      weekly === null ? null : (c.start.rows.find((r) => r.kind === weekly)?.percent ?? null);
    const endWeekly =
      weekly === null
        ? null
        : (c.blocks.at(-1)?.after.rows.find((r) => r.kind === weekly)?.percent ?? null);
    report.add(
      "S2c: Verbrauch Woche gesamt",
      `≤ ${String(c.budgetPp)} Prozentpunkte (freigegeben)`,
      `${String(startWeekly)} % → ${String(endWeekly)} %`,
      null,
    );
  }

  // S2d
  const d = results.d;
  if (d !== undefined && (d.abbruch ?? null) !== null) {
    report.invalid("S2d: Grundkosten", "Läufe ausgeführt", `abgebrochen: ${d.abbruch ?? ""}`);
  }
  if (d !== undefined && d.runs.length > 0) {
    report.table(
      "S2d: Grundkosten je Lauf („Antworte mit OK“, Verfassung, 8 Werkzeuge)",
      ["Modell", "Input", "Cache-Erstellung", "Cache-Lesen", "Output", "USD", "Ergebnis", "Mängel"],
      d.runs.map((r) => [
        r.model,
        String(r.usage?.inputTokens ?? "–"),
        String(r.usage?.cacheCreationInputTokens ?? "–"),
        String(r.usage?.cacheReadInputTokens ?? "–"),
        String(r.usage?.outputTokens ?? "–"),
        fmt(r.costUsd),
        r.subtype ?? "–",
        r.mangel === undefined ? "nicht geprüft" : r.mangel.join("; ") || "keine",
      ]),
    );
    for (const model of ["haiku", "sonnet"]) {
      const own = d.runs.filter((r) => r.model === model);
      const valid = own.filter((r) => r.mangel !== undefined && r.mangel.length === 0);
      const test = `S2d: Grundkosten ${model} (Median)`;
      if (valid.length < own.length || valid.length === 0) {
        // Ohne verbundenen Server und alle 8 Werkzeuge fehlen die Schemas in den Grundkosten.
        report.invalid(
          test,
          "alle Läufe gültig (success, office verbunden, 8 Werkzeuge)",
          `${String(valid.length)} von ${String(own.length)} Läufen gültig`,
        );
      } else {
        const costs = valid.map((r) => r.costUsd ?? Number.NaN);
        report.add(test, "Messwert", `${fmt(median(costs))} USD`, null);
      }
    }
  }

  // S2e
  const all = [...(c?.blocks.flatMap((bl) => bl.runs) ?? []), ...(d?.runs ?? [])];
  if (all.length > 0) {
    const counts: Record<string, number> = {};
    const statuses: Record<string, number> = {};
    for (const r of all) {
      for (const [k, v] of Object.entries(r.eventCounts)) {
        counts[k] = (counts[k] ?? 0) + v;
      }
      for (const rl of r.rateLimits) {
        statuses[rl.status] = (statuses[rl.status] ?? 0) + 1;
      }
    }
    report.add(
      "S2e: rate_limit_event im stream-json",
      "dokumentiert",
      Object.keys(statuses).length === 0 ? "nicht gesehen" : `gesehen: ${JSON.stringify(statuses)}`,
      null,
    );
    report.table(
      "S2e: Ereignisse in allen Läufen",
      ["Ereignis", "Anzahl"],
      Object.entries(counts)
        .sort()
        .map(([k, v]) => [k, String(v)]),
    );
  }

  report.section("Folge laut Plan", [
    "No-Go bei S2a oder S2c: Fallback aus plan.md Kap. 6 (Wochenbudget in USD, Pause bei",
    "allowed_warning); E3 gilt dann nur als Näherung.",
  ]);
  return report;
}

async function main(): Promise<void> {
  const [command, part] = process.argv.slice(2);
  const results = load();
  const parts: Record<string, (r: Results) => Promise<void>> = {
    a: teilA,
    b: teilB,
    c: teilC,
    d: teilD,
  };
  if (command === "teil" && part !== undefined && part in parts) {
    await parts[part]?.(results);
  } else if (command === "alles") {
    // Frisch beginnen: Ergebnisse früherer Durchläufe dürfen sich nicht in den Bericht mischen.
    for (const key of Object.keys(results) as (keyof Results)[]) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Ergebnis gezielt verwerfen
      delete results[key];
    }
    save(results);
    for (const [name, fn] of Object.entries(parts)) {
      try {
        await fn(results);
      } catch (error) {
        console.log(`  übersprungen: ${error instanceof Error ? error.message : String(error)}`);
        if (name === "c") {
          // C kann mitten in den bezahlten Läufen gescheitert sein: D nicht mehr starten.
          console.log("  S2d entfällt, weil S2c nicht vollständig gelaufen ist.");
          break;
        }
      }
      const abbruch = name === "c" ? (results.c?.abbruch ?? null) : null;
      if (abbruch !== null) {
        console.log(`  S2d entfällt wegen Abbruch in S2c: ${abbruch}`);
        break;
      }
    }
  } else if (command === "bericht") {
    const context =
      part === undefined || !existsSync(part) ? [] : readFileSync(part, "utf8").trim().split("\n");
    buildReport(results, context).write(join(WORK, "S2-bericht.md"));
  } else {
    throw new Error("Aufruf: s2.ts teil a|b|c|d | alles | bericht [kontextdatei]");
  }
}

if (isMain(import.meta.url)) {
  await main();
}
