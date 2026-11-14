/**
 * Spike S1g: Netz des Lauf-Containers (docs/etappe-0.md 3.1, plan.md 4.6 „Netz“, 5.7, E29, E40).
 * Aus dem Lauf-Container müssen scheitern: Host, andere Container, Internet direkt, DNS direkt.
 * Gehen müssen: Proxy, Port der Office-API und Supervisor-Gateway (beide als Attrappe).
 * Kein LLM-Aufruf, kein Token nötig.
 *
 *   node s1g.ts server <port>                 Attrappe (HTTP, antwortet „ok“)
 *   node s1g.ts probe <spec.json> <ergebnis.json>
 *   node s1g.ts bericht <verzeichnis> [kontextdatei]
 */
import { promises as dns } from "node:dns";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { Report } from "./bericht.ts";
import { isMain } from "./cli.ts";

export type Kind = "tcp" | "dns-system" | "dns-direkt" | "http" | "proxy-connect";

export interface ProbeSpec {
  name: string;
  kind: Kind;
  /** Host oder IP; bei dns-system und dns-direkt der aufzulösende Name. */
  target: string;
  port?: number;
  /** dns-direkt: Server; proxy-connect: Ziel hinter dem Proxy (host:port). */
  via?: string;
  expect: "geht" | "scheitert";
  /** Nur Information, nicht Teil des Go-Kriteriums. */
  infoOnly?: boolean;
}

export interface ProbeResult {
  name: string;
  expect: "geht" | "scheitert";
  reached: boolean;
  detail: string;
  infoOnly: boolean;
}

const TIMEOUT_MS = 4000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Zeitüberschreitung nach ${String(ms)} ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function tcp(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, timeout: TIMEOUT_MS });
    socket.once("connect", () => {
      socket.destroy();
      resolve("verbunden");
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Zeitüberschreitung"));
    });
    socket.once("error", reject);
  });
}

function httpGet(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path: "/", method: "GET", timeout: TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(`HTTP ${String(res.statusCode)}`);
    });
    req.once("timeout", () => req.destroy(new Error("Zeitüberschreitung")));
    req.once("error", reject);
    req.end();
  });
}

function proxyConnect(proxy: string, port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: proxy,
      port,
      method: "CONNECT",
      path: target,
      timeout: TIMEOUT_MS,
    });
    req.once("connect", (res, socket) => {
      socket.destroy();
      if (res.statusCode === 200) {
        resolve("CONNECT 200");
      } else {
        reject(new Error(`CONNECT ${String(res.statusCode)}`));
      }
    });
    req.once("timeout", () => req.destroy(new Error("Zeitüberschreitung")));
    req.once("error", reject);
    req.end();
  });
}

export async function probeOne(spec: ProbeSpec): Promise<ProbeResult> {
  const base = { name: spec.name, expect: spec.expect, infoOnly: spec.infoOnly === true };
  try {
    let detail: string;
    switch (spec.kind) {
      case "tcp":
        detail = await tcp(spec.target, spec.port ?? 0);
        break;
      case "http":
        detail = await httpGet(spec.target, spec.port ?? 80);
        break;
      case "proxy-connect":
        detail = await proxyConnect(spec.target, spec.port ?? 8080, spec.via ?? "");
        break;
      case "dns-system": {
        const r = await withTimeout(dns.lookup(spec.target, { all: true }), TIMEOUT_MS);
        detail = `aufgelöst (${String(r.length)} Adresse(n))`;
        break;
      }
      case "dns-direkt": {
        const resolver = new dns.Resolver({ timeout: TIMEOUT_MS, tries: 1 });
        resolver.setServers([spec.via ?? ""]);
        const r = await withTimeout(resolver.resolve4(spec.target), TIMEOUT_MS + 1000);
        detail = `aufgelöst (${String(r.length)} Adresse(n))`;
        break;
      }
    }
    return { ...base, reached: true, detail };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { ...base, reached: false, detail: e.code ?? e.message ?? String(error) };
  }
}

export function verdict(result: ProbeResult): boolean | null {
  if (result.infoOnly) {
    return null;
  }
  return result.reached === (result.expect === "geht");
}

export function buildReport(dir: string, context: string[]): Report {
  const report = new Report("S1g – Netz des Lauf-Containers", context);
  const file = join(dir, "ergebnis.json");
  const results = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ProbeResult[]) : [];
  if (results.length === 0) {
    report.invalid("Netzprobe", "ausgeführt", "keine Ergebnisse");
  }
  for (const r of results) {
    report.add(r.name, r.expect, `${r.reached ? "geht" : "scheitert"} (${r.detail})`, verdict(r));
  }
  report.section("Folge laut Plan", ["No-Go: Netzaufbau korrigieren (docs/etappe-0.md 3.1)."]);
  return report;
}

async function main(): Promise<void> {
  const [command, a, b] = process.argv.slice(2);
  if (command === "server" && a !== undefined) {
    createServer((_req, res) => {
      res.end("ok\n");
    }).listen(Number(a), "0.0.0.0");
  } else if (command === "probe" && a !== undefined && b !== undefined) {
    const specs = JSON.parse(readFileSync(a, "utf8")) as ProbeSpec[];
    const results: ProbeResult[] = [];
    for (const spec of specs) {
      const result = await probeOne(spec);
      console.log(`${spec.name}: ${result.reached ? "geht" : "scheitert"} (${result.detail})`);
      results.push(result);
    }
    writeFileSync(b, JSON.stringify(results, null, 2));
  } else if (command === "bericht" && a !== undefined) {
    const context =
      b === undefined || !existsSync(b) ? [] : readFileSync(b, "utf8").trim().split("\n");
    buildReport(a, context).write(join(a, "S1g-bericht.md"));
  } else {
    throw new Error(
      "Aufruf: s1g.ts server <port> | probe <spec> <ergebnis> | bericht <verzeichnis>",
    );
  }
}

if (isMain(import.meta.url)) {
  await main();
}
