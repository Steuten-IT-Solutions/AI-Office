import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mask } from "./bericht.ts";
import { summarize, type RunSummary } from "./stream.ts";

/**
 * Startet `claude -p` im Lauf-Container. Die Flags folgen plan.md Kap. 5.7:
 *
 * ```
 * claude -p --output-format stream-json --verbose --model <m> --max-turns <n> --max-budget-usd <b>
 *        --permission-mode dontAsk --permission-prompts none --allowedTools <je Lauftyp>
 *        --setting-sources user --settings <vom Supervisor, inkl. disableAllHooks>
 * ```
 *
 * Quellen der Flags: https://code.claude.com/docs/en/cli-reference (geprüft am 05.11.2026 an der
 * Hilfe von 2.1.318; im Image steckt 2.1.312, `bauen.sh` prüft die Flags dort noch einmal).
 */

export interface ClaudeRun {
  prompt: string;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  allowedTools: string[];
  /** `null`: Flag weglassen (Kontrolle in S1f). Standard laut Plan: `user`. */
  settingSources?: string | null;
  /** `null`: Flag weglassen. Standard laut Plan: `{"disableAllHooks": true}`. */
  settings?: Record<string, unknown> | null;
  extraArgs?: string[];
  cwd: string;
  /** Umgebung für den Kindprozess. Variablen mit Wert `undefined` werden entfernt. */
  env?: Record<string, string | undefined>;
  /** Eingabe auf stdin (für `--input-format stream-json`). */
  stdin?: string;
  timeoutMs?: number;
  /** Ausgabe zusätzlich (maskiert) in diese Datei schreiben. */
  rawFile?: string;
}

export interface ClaudeResult extends RawResult {
  summary: RunSummary;
}

export const PLAN_SETTINGS = { disableAllHooks: true } as const;

export function buildArgs(run: ClaudeRun): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    run.model,
    "--max-turns",
    String(run.maxTurns),
    "--max-budget-usd",
    String(run.maxBudgetUsd),
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
  ];
  if (run.allowedTools.length > 0) {
    // Jede Regel als eigenes Argument, damit Leerzeichen in `Bash(…)` erhalten bleiben.
    args.push("--allowedTools", ...run.allowedTools);
  }
  const sources = run.settingSources === undefined ? "user" : run.settingSources;
  if (sources !== null) {
    args.push("--setting-sources", sources);
  }
  const settings = run.settings === undefined ? PLAN_SETTINGS : run.settings;
  if (settings !== null) {
    args.push("--settings", JSON.stringify(settings));
  }
  args.push(...(run.extraArgs ?? []));
  if (run.stdin === undefined) {
    // Der Prompt kommt als letztes Argument; `--` trennt ihn von den Flags.
    args.push("--", run.prompt);
  }
  return args;
}

export function childEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Variable gezielt entfernen
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

export interface RawResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** stdout, maskiert. */
  stdout: string;
  /** Erste 20 Zeilen von stderr, maskiert. */
  stderr: string;
}

/** Startet das CLI mit beliebigen Argumenten (für `/usage` in S2a). */
export function spawnClaude(
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
    stdin?: string;
    timeoutMs?: number;
  },
  binary = "claude",
): Promise<RawResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    // Eigene Prozessgruppe, damit die Zeitgrenze auch Bash- und MCP-Kindprozesse trifft.
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: childEnv(process.env, options.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, signal);
        }
      } catch {
        // Gruppe schon beendet
      }
    };
    // Zeitgrenze wie plan.md 5.7: erst SIGINT, dann SIGTERM, dann Kill, jeweils an die Gruppe.
    timers.push(
      setTimeout(() => {
        timedOut = true;
        signalGroup("SIGINT");
        timers.push(
          setTimeout(() => {
            signalGroup("SIGTERM");
          }, 10_000),
        );
        timers.push(
          setTimeout(() => {
            signalGroup("SIGKILL");
          }, 20_000),
        );
      }, options.timeoutMs ?? 300_000),
    );
    const clearTimers = (): void => {
      for (const t of timers) {
        clearTimeout(t);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    // Hält ein Enkelprozess außerhalb der Gruppe stdout/stderr offen, käme `close` nie.
    // Deshalb nach dem Ende des CLI höchstens 5 s auf die Pipes warten.
    child.on("exit", () => {
      timers.push(
        setTimeout(() => {
          signalGroup("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
        }, 5_000),
      );
    });
    child.on("close", (code) => {
      clearTimers();
      resolve({
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        stdout: mask(Buffer.concat(out).toString("utf8")),
        stderr: mask(Buffer.concat(err).toString("utf8")).split("\n").slice(0, 20).join("\n"),
      });
    });
    // Endet das CLI, bevor es stdin liest, käme sonst ein unbehandeltes EPIPE.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
  });
}

export async function runClaude(run: ClaudeRun, binary = "claude"): Promise<ClaudeResult> {
  const options: Parameters<typeof spawnClaude>[1] = { cwd: run.cwd };
  if (run.env !== undefined) {
    options.env = run.env;
  }
  if (run.stdin !== undefined) {
    options.stdin = run.stdin;
  }
  if (run.timeoutMs !== undefined) {
    options.timeoutMs = run.timeoutMs;
  }
  const raw = await spawnClaude(buildArgs(run), options, binary);
  if (run.rawFile !== undefined) {
    writeFileSync(run.rawFile, raw.stdout);
  }
  return { ...raw, summary: summarize(raw.stdout) };
}

/** Kurzbeschreibung eines Laufs für den Bericht. */
export function describe(result: ClaudeResult): string {
  const s = result.summary;
  const parts = [
    `Exit ${String(result.exitCode)}`,
    `Ergebnis ${s.resultSubtype ?? "keins"}`,
    `Kosten ${s.totalCostUsd === null ? "?" : s.totalCostUsd.toFixed(4)} USD`,
    `Turns ${String(s.numTurns ?? "?")}`,
  ];
  if (result.timedOut) {
    parts.push("Zeitüberschreitung");
  }
  if (s.resultSubtype === null && result.stderr.trim() !== "") {
    parts.push(`stderr: ${result.stderr.trim().split("\n")[0] ?? ""}`);
  }
  return parts.join(", ");
}
