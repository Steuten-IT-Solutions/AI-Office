/**
 * Spike S1b: Welche Anthropic-Endpunkte braucht das CLI? Funktioniert ein TLS-terminierender
 * Proxy mit Allowlist? (docs/etappe-0.md 3.1, plan.md 5.7 „Netz“, E29)
 *
 *   node s1b.ts durchgang <n>        im Lauf-Container: drei typische Läufe über den Proxy
 *   node s1b.ts negativ              im Lauf-Container: Anfragen, die der Proxy blockieren muss
 *   node s1b.ts allowlist <protokoll> <ziel>
 *   node s1b.ts bericht <verzeichnis> [kontextdatei]
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Report } from "./bericht.ts";
import { describe, runClaude, type ClaudeRun } from "./claude.ts";
import { isMain } from "./cli.ts";
import { buildAllowlist, countByEndpoint, parseLog } from "./endpunkte.ts";
import { summarize, succeeded } from "./stream.ts";

const run = promisify(execFile);

export const ATTRAPPE = "/opt/spike/spikes/vm/src/mcp-attrappe.ts";

type RunSpec = Omit<ClaudeRun, "cwd" | "rawFile">;

/** Die drei typischen Läufe aus der Spike-Beschreibung. */
export const RUNS: Record<string, RunSpec> = {
  text: {
    prompt: "Antworte nur mit dem Wort OK.",
    model: "haiku",
    maxTurns: 1,
    maxBudgetUsd: 0.05,
    allowedTools: [],
  },
  werkzeuge: {
    prompt:
      "Lies die Datei notiz.txt mit dem Read-Werkzeug. Führe danach mit dem Bash-Werkzeug genau den Befehl `wc -c notiz.txt` aus. Antworte mit der Zahl, die in der Datei steht.",
    model: "haiku",
    maxTurns: 4,
    maxBudgetUsd: 0.05,
    allowedTools: ["Read", "Bash(wc -c notiz.txt)"],
  },
  mcp: {
    prompt: "Rufe das Werkzeug mcp__attrappe__ping auf und antworte mit seinem Ergebnis.",
    model: "haiku",
    maxTurns: 3,
    maxBudgetUsd: 0.05,
    allowedTools: ["mcp__attrappe__ping"],
    extraArgs: [
      "--mcp-config",
      JSON.stringify({
        mcpServers: { attrappe: { command: "node", args: [ATTRAPPE, "--name", "attrappe"] } },
      }),
    ],
  },
};

async function durchgang(n: string): Promise<void> {
  for (const [name, spec] of Object.entries(RUNS)) {
    const cwd = `/work/lauf-${n}-${name}`;
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd);
    writeFileSync(join(cwd, "notiz.txt"), "42\n");
    const result = await runClaude({ ...spec, cwd, rawFile: `/work/lauf-${n}-${name}.jsonl` });
    writeFileSync(`/work/stderr-${n}-${name}.txt`, result.stderr);
    console.log(`Durchgang ${n}, ${name}: ${describe(result)}`);
  }
}

// Attrappen fremder Zugangsdaten, zur Laufzeit zusammengesetzt, damit kein Secret-Scanner sie für
// echte hält. Sie haben das Präfix echter Schlüssel, damit der Proxy sie wie solche sieht.
const FREMDER_KEY = ["sk", "ant", "api03", "attrappe", "kein", "echter", "schluessel"].join("-");
const FREMDES_TOKEN = ["sk", "ant", "oat01", "attrappe", "kein", "echtes", "token"].join("-");

export interface NegativeTest {
  name: string;
  url: string;
  method: string;
  /** Header; `$TOKEN` wird im Container durch das setup-token ersetzt (nie ausgegeben). */
  headers: string[];
}

export const NEGATIVE: NegativeTest[] = [
  {
    name: "fremder API-Key (x-api-key) auf /v1/messages",
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: [`x-api-key: ${FREMDER_KEY}`, "content-type: application/json"],
  },
  {
    name: "fremdes Bearer-Token auf /v1/messages",
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: [`authorization: Bearer ${FREMDES_TOKEN}`, "content-type: application/json"],
  },
  {
    name: "unser Token plus fremder x-api-key auf /v1/messages",
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: ["authorization: Bearer $TOKEN", `x-api-key: ${FREMDER_KEY}`],
  },
  {
    name: "unser Token auf der Files-API (/v1/files)",
    url: "https://api.anthropic.com/v1/files",
    method: "GET",
    headers: ["authorization: Bearer $TOKEN"],
  },
  {
    name: "fremder Host (example.com)",
    url: "https://example.com/",
    method: "GET",
    headers: [],
  },
];

export interface NegativeResult {
  name: string;
  /** HTTP-Status der Antwort bzw. der CONNECT-Antwort des Proxys. */
  status: string;
  blockedByProxy: boolean;
  detail: string;
}

/** Wertet die Ausgabe von `curl -D - -w '\n%{http_code} %{http_connect}'` aus. */
export function interpretCurl(stdout: string, exitCode: number): Omit<NegativeResult, "name"> {
  const lines = stdout.trim().split("\n");
  const last = lines.at(-1) ?? "";
  const [code = "000", connect = "000"] = last.trim().split(" ");
  const proxyHeader = lines.some((l) => /^x-aio-proxy:\s*blockiert/i.test(l));
  const blockedConnect = connect === "403";
  return {
    status: blockedConnect ? `CONNECT ${connect}` : code,
    blockedByProxy: proxyHeader || blockedConnect,
    detail: `curl Exit ${String(exitCode)}`,
  };
}

async function negativ(): Promise<void> {
  const token = process.env["CLAUDE_CODE_OAUTH_TOKEN"] ?? "";
  const results: NegativeResult[] = [];
  for (const test of NEGATIVE) {
    // Header kommen aus einer Datei (curl -H @datei), damit das Token in keiner Kommandozeile steht.
    const headerFile = "/tmp/s1b-header.txt";
    writeFileSync(
      headerFile,
      test.headers.map((h) => h.replace("$TOKEN", token)).join("\n") + "\n",
      {
        mode: 0o600,
      },
    );
    const args = [
      "-s",
      "-o",
      "/dev/null",
      "-D",
      "-",
      "-w",
      "\n%{http_code} %{http_connect}",
      "--max-time",
      "20",
      "--cacert",
      "/aio-ca/ca.pem",
      "-X",
      test.method,
      "-H",
      `@${headerFile}`,
    ];
    if (test.method === "POST") {
      args.push("--data", "{}");
    }
    args.push(test.url);
    let stdout: string;
    let exitCode = 0;
    try {
      stdout = (await run("curl", args)).stdout;
    } catch (error) {
      const e = error as { stdout?: string; code?: number };
      stdout = e.stdout ?? "";
      exitCode = typeof e.code === "number" ? e.code : -1;
    } finally {
      rmSync(headerFile, { force: true });
    }
    const result = { name: test.name, ...interpretCurl(stdout, exitCode) };
    results.push(result);
    console.log(
      `${test.name}: ${result.blockedByProxy ? "blockiert" : "NICHT blockiert"} (${result.status})`,
    );
  }
  writeFileSync("/work/negativ.json", JSON.stringify(results, null, 2));
}

function read(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function buildReport(dir: string, context: string[]): Report {
  const report = new Report("S1b – Endpunkte und Proxy mit Allowlist", context);
  const log1 = parseLog(read(join(dir, "protokoll-1.jsonl")));
  const log2 = parseLog(read(join(dir, "protokoll-2.jsonl")));

  for (const n of ["1", "2"]) {
    for (const name of Object.keys(RUNS)) {
      const stdout = read(join(dir, `lauf-${n}-${name}.jsonl`));
      const summary = summarize(stdout);
      const stderr =
        read(join(dir, `stderr-${n}-${name}.txt`))
          .trim()
          .split("\n")[0] ?? "";
      const label = n === "1" ? "Durchgang 1 (nur Protokoll)" : "Durchgang 2 (Allowlist)";
      const mcp =
        name === "mcp"
          ? `, MCP: ${summary.mcpServers.map((s) => `${s.name}=${s.status}`).join(" ") || "keiner"}`
          : "";
      report.add(
        `${label}: Lauf ${name}`,
        "erfolgreich",
        `${summary.resultSubtype ?? `kein Ergebnis${stderr === "" ? "" : ` (${stderr})`}`}${mcp}`,
        n === "1" ? (succeeded(summary) ? true : null) : succeeded(summary),
      );
    }
  }
  if (log1.length === 0) {
    report.invalid("Protokoll Durchgang 1", "Anfragen protokolliert", "leer");
  }
  const hosts = [...new Set(log1.map((e) => e.host))].sort();
  report.add("Hosts in Durchgang 1", "nur Anthropic", hosts.join(", ") || "keine", null);

  const blocked2 = log2.filter((e) => e.entscheidung.startsWith("blockiert"));
  report.add(
    "Durchgang 2: vom Proxy blockierte Anfragen der Läufe",
    "keine",
    blocked2.length === 0
      ? "keine"
      : blocked2.map((e) => `${e.methode} ${e.host}${e.pfad} (${e.auth})`).join("; "),
    null,
  );

  const negativeFile = join(dir, "negativ.json");
  const negatives = existsSync(negativeFile)
    ? (JSON.parse(readFileSync(negativeFile, "utf8")) as NegativeResult[])
    : [];
  if (negatives.length === 0) {
    report.invalid("Negativtests", "ausgeführt", "keine Ergebnisse");
  }
  for (const neg of negatives) {
    report.add(
      `Blockiert: ${neg.name}`,
      "vom Proxy blockiert",
      `${neg.blockedByProxy ? "blockiert" : "NICHT blockiert"} (${neg.status}, ${neg.detail})`,
      neg.blockedByProxy,
    );
  }

  report.table(
    "Endpunkte in Durchgang 1",
    ["Methode", "Host", "Pfad", "Anmeldung", "Entscheidung", "Anzahl"],
    countByEndpoint(log1),
  );
  report.table(
    "Anfragen in Durchgang 2",
    ["Methode", "Host", "Pfad", "Anmeldung", "Entscheidung", "Anzahl"],
    countByEndpoint(log2),
  );
  report.section("Allowlist (aus Durchgang 1 erzeugt)", [
    "```json",
    read(join(dir, "allowlist.json")).trim(),
    "```",
  ]);
  report.section("Folge laut Plan", [
    "Go: Die Läufe funktionieren mit Allowlist, fremde Schlüssel werden blockiert. No-Go: Kanal als",
    "Restrisiko unter R6 entscheiden (plan.md 5.7).",
  ]);
  return report;
}

async function main(): Promise<void> {
  const [command, a, b] = process.argv.slice(2);
  if (command === "durchgang" && a !== undefined) {
    await durchgang(a);
  } else if (command === "negativ") {
    await negativ();
  } else if (command === "allowlist" && a !== undefined && b !== undefined) {
    const eintraege = buildAllowlist(parseLog(read(a)));
    writeFileSync(b, JSON.stringify({ eintraege }, null, 2) + "\n");
    console.log(`Allowlist mit ${String(eintraege.length)} Einträgen: ${b}`);
  } else if (command === "bericht" && a !== undefined) {
    const context = b === undefined ? [] : read(b).trim().split("\n");
    buildReport(a, context).write(join(a, "S1b-bericht.md"));
  } else {
    throw new Error(
      "Aufruf: s1b.ts durchgang <n> | negativ | allowlist <protokoll> <ziel> | bericht <verzeichnis>",
    );
  }
}

if (isMain(import.meta.url)) {
  await main();
}
