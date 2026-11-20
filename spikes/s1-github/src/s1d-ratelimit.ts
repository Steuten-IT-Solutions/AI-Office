/**
 * Spike S1d: Reicht das Rate-Limit der App für Polling? (plan.md Kap. 5.9)
 *
 * Legt zwei Test-PRs an, misst die Kosten eines Poll-Zyklus (PR-Liste, Reviews und Checks je PR)
 * und prüft, ob bedingte Anfragen mit ETag (HTTP 304) zählen. Danach werden die PRs geschlossen
 * und die Branches gelöscht.
 *
 * Gemessen wird über GET /rate_limit, und zwar erst, wenn der Zähler still steht. Der erste Lauf
 * am 20.11.2026 hat Einzelwerte aus den Antwort-Headern verglichen. Dabei stieg der Zähler um 13,
 * obwohl nur eine 304-Anfrage dazwischen lag. Eine Ruhemessung und eine Kontrolle mit normalen
 * Anfragen zeigen jetzt, ob die Messung selbst stimmt.
 */
import { api, installationToken, loadConfig } from "./github.ts";
import { Report } from "./report.ts";

const TEST_PRS = 2;
/** Annahmen für die Hochrechnung (docs/etappe-0.md, S1d). */
const OPEN_PRS = 10;
const INTERVAL_SECONDS = 60;
const MAX_SHARE = 0.2;

export function requestsPerCycle(openPrs: number): number {
  return 1 + 2 * openPrs;
}

export function hourlyShare(perCycle: number, intervalSeconds: number, limit: number): number {
  return (perCycle * (3600 / intervalSeconds)) / limit;
}

/** Pause zwischen zwei Lesungen des Zählers, damit verzögerte Buchungen sichtbar werden. */
const SETTLE_MS = 5000;
/** Höchstzahl der Lesungen, bis der Zähler zweimal hintereinander gleich ist. */
const SETTLE_TRIES = 12;
const IDLE_MS = 15000;
const SAMPLES = 10;
const CYCLES = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Snapshot {
  used: number;
  limit: number;
  reset: number;
}

/** Liest den Zähler über GET /rate_limit, das laut GitHub-Doku selbst nicht zählt. */
async function snapshot(token: string): Promise<Snapshot> {
  const response = await api(token, "GET", "/rate_limit");
  const core = (response.body as { resources?: { core?: Snapshot } }).resources?.core;
  if (core === undefined) {
    throw new Error(`GET /rate_limit ohne resources.core (HTTP ${String(response.status)})`);
  }
  return core;
}

/** Wartet, bis zwei Lesungen im Abstand von SETTLE_MS gleich sind. */
async function settled(token: string): Promise<Snapshot> {
  let last = await snapshot(token);
  for (let i = 0; i < SETTLE_TRIES; i++) {
    await sleep(SETTLE_MS);
    const now = await snapshot(token);
    if (now.used === last.used && now.reset === last.reset) {
      return now;
    }
    last = now;
  }
  throw new Error("Zähler steht nicht still, fremde Anfragen auf derselben Installation?");
}

/**
 * Verbrauch einer Aktion: Zählerstand nach dem Stillstand minus Zählerstand davor.
 * null, wenn das Stundenfenster dazwischen zurückgesetzt wurde.
 */
export async function measure(
  token: string,
  action: () => Promise<void>,
  read: (token: string) => Promise<Snapshot> = settled,
): Promise<number | null> {
  const before = await read(token);
  await action();
  const after = await read(token);
  return after.reset === before.reset ? after.used - before.used : null;
}

function showDelta(delta: number | null): string {
  return delta === null ? "Stundenfenster zurückgesetzt, bitte wiederholen" : `+${String(delta)}`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const token = await installationToken(config);
  const repoPath = `/repos/${config.owner}/${config.repo}`;
  const report = new Report("S1d – Rate-Limit für Polling");
  const stamp = String(Date.now());
  const branches: string[] = [];
  const prNumbers: number[] = [];

  const repo = await api(token, "GET", repoPath);
  const defaultBranch = (repo.body as { default_branch: string }).default_branch;

  try {
    const head = await api(token, "GET", `${repoPath}/git/ref/heads/${defaultBranch}`);
    const baseSha = (head.body as { object: { sha: string } }).object.sha;
    for (let i = 0; i < TEST_PRS; i++) {
      const branch = `spike/s1d-${stamp}-${String(i)}`;
      const ref = await api(token, "POST", `${repoPath}/git/refs`, {
        body: { ref: `refs/heads/${branch}`, sha: baseSha },
      });
      if (ref.status !== 201) {
        throw new Error(`Branch nicht angelegt (HTTP ${String(ref.status)})`);
      }
      branches.push(branch);
      const file = await api(token, "PUT", `${repoPath}/contents/s1d-${stamp}-${String(i)}.txt`, {
        body: {
          message: "s1d: PR-Inhalt",
          content: Buffer.from(`s1d ${String(i)}\n`).toString("base64"),
          branch,
        },
      });
      if (file.status !== 201) {
        throw new Error(`PR-Inhalt nicht angelegt (HTTP ${String(file.status)})`);
      }
      const pr = await api(token, "POST", `${repoPath}/pulls`, {
        body: { title: `s1d Test ${String(i)}`, head: branch, base: defaultBranch },
      });
      if (pr.status !== 201) {
        throw new Error(`PR nicht angelegt (HTTP ${String(pr.status)})`);
      }
      prNumbers.push((pr.body as { number: number }).number);
    }

    const first = await snapshot(token);
    const limit = first.limit;
    report.add("Limit der Installation", "≥ 5.000/h", `${String(limit)}/h`, limit >= 5000);

    // Die Anlage der PRs oben hat den Zähler bewegt. Erst warten, bis er still steht.
    const idle = await measure(token, () => sleep(IDLE_MS));
    report.add(
      `Ruhemessung: ${String(IDLE_MS / 1000)} s ohne Anfragen`,
      "+0",
      showDelta(idle),
      idle === null ? false : idle === 0,
    );

    const listPath = `${repoPath}/pulls?state=open&per_page=100`;
    const control = await measure(token, async () => {
      for (let i = 0; i < SAMPLES; i++) {
        await api(token, "GET", listPath);
      }
    });
    report.add(
      `Kontrolle: ${String(SAMPLES)} normale GET-Anfragen`,
      `+${String(SAMPLES)}`,
      showDelta(control),
      control === SAMPLES,
    );

    let openPrs = 0;
    const cycles = await measure(token, async () => {
      for (let c = 0; c < CYCLES; c++) {
        const list = await api(token, "GET", listPath);
        const pulls = list.body as { number: number; head: { sha: string } }[];
        openPrs = pulls.length;
        for (const pr of pulls) {
          await api(token, "GET", `${repoPath}/pulls/${String(pr.number)}/reviews`);
          await api(token, "GET", `${repoPath}/commits/${pr.head.sha}/check-runs`);
        }
      }
    });
    const cycleCost = cycles === null ? null : cycles / CYCLES;
    report.add(
      `Kosten eines Poll-Zyklus mit ${String(openPrs)} offenen PRs (Mittel aus ${String(CYCLES)})`,
      `${String(requestsPerCycle(openPrs))} Anfragen (1 + 2 je PR)`,
      cycleCost === null ? showDelta(null) : `${String(cycleCost)} Anfragen`,
      cycleCost !== null && cycleCost <= requestsPerCycle(openPrs),
    );

    let conditionalFree = false;
    const reference = await api(token, "GET", listPath);
    const etag = reference.etag;
    if (etag === null) {
      report.add("Bedingte Anfrage (If-None-Match)", "ETag vorhanden", "kein ETag", false);
    } else {
      const statuses = new Set<number>();
      const conditional = await measure(token, async () => {
        for (let i = 0; i < SAMPLES; i++) {
          statuses.add((await api(token, "GET", listPath, { etag })).status);
        }
      });
      const all304 = statuses.size === 1 && statuses.has(304);
      report.add(
        `Bedingte Anfragen (If-None-Match), ${String(SAMPLES)} Stück`,
        "alle HTTP 304",
        `HTTP ${[...statuses].join(", ")}`,
        all304,
      );
      conditionalFree = all304 && conditional === 0;
      report.add(
        "Zählen 304-Antworten gegen das Limit?",
        "messen (Doku: nein)",
        conditional === null
          ? showDelta(null)
          : conditional === 0
            ? "nein (+0)"
            : `ja (+${String(conditional)} für ${String(SAMPLES)})`,
        null,
      );
    }

    const share = hourlyShare(requestsPerCycle(OPEN_PRS), INTERVAL_SECONDS, limit);
    report.add(
      `Hochrechnung: ${String(OPEN_PRS)} offene PRs, Intervall ${String(INTERVAL_SECONDS)} s, ohne ETag`,
      `< ${String(MAX_SHARE * 100)} % des Limits, oder 304-Antworten zählen nicht`,
      `${(share * 100).toFixed(1)} %${conditionalFree ? " (mit ETag fallen unveränderte Abfragen weg)" : ""}`,
      share < MAX_SHARE || conditionalFree,
    );
  } finally {
    for (const number of prNumbers) {
      await api(token, "PATCH", `${repoPath}/pulls/${String(number)}`, {
        body: { state: "closed" },
      });
    }
    for (const branch of branches) {
      await api(token, "DELETE", `${repoPath}/git/refs/heads/${branch}`);
    }
    report.add(
      "Aufräumen",
      "PRs geschlossen, Branches gelöscht",
      `${String(prNumbers.length)} PRs, ${String(branches.length)} Branches`,
      null,
    );
  }

  report.write("s1d-bericht.md");
  if (!report.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
