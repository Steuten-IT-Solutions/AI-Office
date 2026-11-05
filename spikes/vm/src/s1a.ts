/**
 * Spike S1a: Kann Bash im Container das setup-token lesen? (docs/etappe-0.md 3.1, plan.md 5.7)
 *
 *   node s1a.ts lauf <bezeichnung>   im Lauf-Container: ein `claude -p`-Lauf, der nur die Probe
 *                                    ausführt; Ausgabe nach /work/lauf-<bezeichnung>.jsonl
 *   node s1a.ts bericht <verzeichnis> <kontextdatei>
 *                                    wertet Proben und Läufe aus und schreibt S1a-bericht.md
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Report } from "./bericht.ts";
import { describe, runClaude } from "./claude.ts";
import { isMain } from "./cli.ts";
import { summarize, succeeded, type RunSummary } from "./stream.ts";

export const PROBE = "/opt/spike/spikes/vm/probe/probe.sh";

export function probeCommand(label: string): string {
  return `bash ${PROBE} ${label}`;
}

export interface ProbeRow {
  lesbar: string;
  treffer: string;
  aehnlich: number;
}

export interface Probe {
  rows: Record<string, ProbeRow>;
  info: Record<string, string>;
  complete: boolean;
  error: string | null;
}

export function parseProbe(text: string): Probe {
  const probe: Probe = { rows: {}, info: {}, complete: false, error: null };
  for (const line of text.split("\n")) {
    const [kind, a = "", b = "", c = ""] = line.split("\t");
    if (kind === undefined || kind === "") {
      continue;
    }
    if (kind === "info") {
      probe.info[a] = b;
    } else if (kind === "ende") {
      probe.complete = true;
    } else if (kind === "fehler") {
      probe.error = a;
    } else {
      probe.rows[kind] = { lesbar: a, treffer: b, aehnlich: Number(c) };
    }
  }
  return probe;
}

const FUNDORTE: Record<string, string> = {
  env: "Umgebung des Bash-Prozesses",
  proc_environ: "/proc/*/environ",
  proc_cmdline: "/proc/*/cmdline",
  dateien: "Dateien unter $HOME, CLAUDE_CONFIG_DIR, /tmp, /work",
};

function readProbe(dir: string, label: string): Probe | null {
  const file = join(dir, `probe-${label}.txt`);
  return existsSync(file) ? parseProbe(readFileSync(file, "utf8")) : null;
}

function readRun(dir: string, label: string): RunSummary | null {
  const file = join(dir, `lauf-${label}.jsonl`);
  return existsSync(file) ? summarize(readFileSync(file, "utf8")) : null;
}

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}

/** Positivkontrollen: Die Probe muss das Token ohne Sandbox finden, sonst ist sie blind. */
export function checkControls(
  report: Report,
  kontrolle: Probe | null,
  datei: Probe | null,
): boolean {
  let valid = true;
  const env = kontrolle?.rows["env"]?.treffer;
  const proc = kontrolle?.rows["proc_environ"]?.treffer;
  const file = datei?.rows["dateien"]?.treffer;
  for (const [name, value] of [
    ["Kontrolle: Token in der Umgebung (docker exec, ohne Sandbox)", env],
    ["Kontrolle: Token in /proc/1/environ (ohne Sandbox)", proc],
    ["Kontrolle: Token in einer Datei unter /tmp", file],
  ] as const) {
    if (value === "ja") {
      report.add(name, "gefunden", "gefunden", true);
    } else {
      report.invalid(name, "gefunden", value ?? "keine Probe");
      valid = false;
    }
  }
  return valid;
}

export function evaluateRun(
  report: Report,
  label: string,
  run: RunSummary | null,
  probe: Probe | null,
  kontrolle: Probe | null,
  stderr: string,
  strict: boolean,
): void {
  const prefix = label === "claude" ? "" : `[${label}] `;
  const ok = (value: boolean): boolean | null => (strict ? value : null);
  if (run === null || probe === null || !probe.complete) {
    const reason =
      run === null
        ? "kein Lauf"
        : `${run.resultSubtype ?? "kein Ergebnis"}; Probe ${probe === null ? "nicht ausgeführt" : "unvollständig"}`;
    report.add(
      `${prefix}Probe über claude -p ausgeführt`,
      "ja",
      `${reason}${stderr === "" ? "" : `; stderr: ${stderr.split("\n")[0] ?? ""}`}`,
      ok(false),
    );
    return;
  }
  const bash = run.toolUses.filter((t) => t.name === "Bash");
  report.add(
    `${prefix}Probe über claude -p ausgeführt`,
    "genau ein Bash-Aufruf mit der Probe",
    `${String(bash.length)} Bash-Aufruf(e): ${bash.map((b) => b.command ?? "?").join("; ")}; Lauf ${succeeded(run) ? "erfolgreich" : (run.resultSubtype ?? "?")}`,
    ok(bash.length === 1 && bash[0]?.command === probeCommand(label)),
  );
  const sandboxed =
    kontrolle !== null &&
    probe.info["ns_user"] !== undefined &&
    probe.info["ns_user"] !== kontrolle.info["ns_user"];
  report.add(
    `${prefix}Sandbox aktiv (eigener User-Namespace)`,
    "ja",
    `${sandboxed ? "ja" : "nein"} (Probe ${probe.info["ns_user"] ?? "?"}, Kontrolle ${kontrolle?.info["ns_user"] ?? "?"}; sichtbare Prozesse ${probe.info["prozesse_sichtbar"] ?? "?"}, CLI-Prozess sichtbar: ${probe.info["claude_prozess_sichtbar"] ?? "?"})`,
    ok(sandboxed),
  );
  for (const [key, name] of Object.entries(FUNDORTE)) {
    const row = probe.rows[key];
    report.add(
      `${prefix}Token in ${name}`,
      "nicht gefunden",
      row === undefined
        ? "keine Angabe"
        : `${row.treffer === "ja" ? "GEFUNDEN" : "nicht gefunden"} (lesbar: ${row.lesbar}, token-ähnlich: ${String(row.aehnlich)})`,
      ok(row?.treffer === "nein"),
    );
  }
}

export function buildReport(dir: string, context: string[]): Report {
  const report = new Report("S1a – setup-token für Bash im Container", context);
  const kontrolle = readProbe(dir, "kontrolle");
  const datei = readProbe(dir, "kontrolle-datei");
  const valid = checkControls(report, kontrolle, datei);
  evaluateRun(
    report,
    "claude",
    readRun(dir, "claude"),
    readProbe(dir, "claude"),
    kontrolle,
    readText(join(dir, "stderr-claude.txt")),
    valid,
  );
  const strict = readRun(dir, "streng");
  if (strict !== null || existsSync(join(dir, "stderr-streng.txt"))) {
    evaluateRun(
      report,
      "streng",
      strict,
      readProbe(dir, "streng"),
      readProbe(dir, "kontrolle-streng"),
      readText(join(dir, "stderr-streng.txt")),
      false,
    );
  }
  report.section("bubblewrap direkt im Container (Diagnose)", [
    "```",
    readText(join(dir, "bwrap.txt")) || "(keine Ausgabe)",
    "```",
  ]);
  report.section("Folge laut Plan", [
    "Go: Bash-Sandbox und Container zusammen (plan.md 5.7). No-Go: R5 ausdrücklich akzeptieren und",
    "Ersatzprüfungen aus 5.13, optional S1a′ (CLI und Bash unter getrennten Nutzern).",
  ]);
  return report;
}

async function lauf(label: string): Promise<void> {
  const result = await runClaude({
    prompt: `Rufe das Bash-Werkzeug genau einmal mit diesem Befehl auf und führe sonst nichts aus: ${probeCommand(label)}\nAntworte danach nur mit FERTIG.`,
    model: "haiku",
    maxTurns: 3,
    maxBudgetUsd: 0.05,
    allowedTools: [`Bash(${probeCommand(label)})`],
    cwd: "/work",
    rawFile: `/work/lauf-${label}.jsonl`,
  });
  writeFileSync(`/work/stderr-${label}.txt`, result.stderr);
  console.log(describe(result));
}

async function main(): Promise<void> {
  const [command, a, b] = process.argv.slice(2);
  if (command === "lauf" && a !== undefined) {
    await lauf(a);
  } else if (command === "bericht" && a !== undefined) {
    const context = b === undefined ? [] : readText(b).split("\n");
    buildReport(a, context).write(join(a, "S1a-bericht.md"));
  } else {
    throw new Error("Aufruf: s1a.ts lauf <bezeichnung> | bericht <verzeichnis> [kontextdatei]");
  }
}

if (isMain(import.meta.url)) {
  await main();
}
