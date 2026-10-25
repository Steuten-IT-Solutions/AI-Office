/**
 * Spike S1d: Reicht das Rate-Limit der App für Polling? (plan.md Kap. 5.9)
 *
 * Legt zwei Test-PRs an, misst die Kosten eines Poll-Zyklus (PR-Liste, Reviews und Checks je PR)
 * über die Header `x-ratelimit-*` und prüft, ob bedingte Anfragen mit ETag (HTTP 304) zählen.
 * Danach werden die PRs geschlossen und die Branches gelöscht.
 */
import { api, installationToken, loadConfig, type ApiResponse } from "./github.ts";
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

function used(response: ApiResponse): number {
  if (response.rate === null) {
    throw new Error("Antwort ohne x-ratelimit-Header");
  }
  return response.rate.used;
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

    const start = await api(token, "GET", "/rate_limit");
    const limit = start.rate?.limit ?? 0;
    report.add("Limit der Installation", "≥ 5.000/h", `${String(limit)}/h`, limit >= 5000);

    const list = await api(token, "GET", `${repoPath}/pulls?state=open&per_page=100`);
    const usedBefore = used(list);
    const pulls = list.body as { number: number; head: { sha: string } }[];
    let lastUsed = usedBefore;
    for (const pr of pulls) {
      const reviews = await api(token, "GET", `${repoPath}/pulls/${String(pr.number)}/reviews`);
      const checks = await api(token, "GET", `${repoPath}/commits/${pr.head.sha}/check-runs`);
      lastUsed = Math.max(used(reviews), used(checks));
    }
    const cycleCost = lastUsed - usedBefore + 1;
    report.add(
      `Kosten eines Poll-Zyklus mit ${String(pulls.length)} offenen PRs`,
      `${String(requestsPerCycle(pulls.length))} Anfragen (1 + 2 je PR)`,
      `${String(cycleCost)} Anfragen`,
      cycleCost <= requestsPerCycle(pulls.length),
    );

    let conditionalFree = false;
    const etag = list.etag;
    if (etag !== null) {
      const before = await api(token, "GET", `${repoPath}/pulls?state=open&per_page=100`);
      const conditional = await api(token, "GET", `${repoPath}/pulls?state=open&per_page=100`, {
        etag: before.etag ?? etag,
      });
      const after = await api(token, "GET", "/rate_limit");
      const delta = (after.rate?.used ?? 0) - used(before);
      report.add(
        "Bedingte Anfrage (If-None-Match)",
        "HTTP 304",
        `HTTP ${String(conditional.status)}, Zähler danach +${String(delta)}`,
        conditional.status === 304,
      );
      conditionalFree = conditional.status === 304 && delta === 0;
      report.add(
        "Zählt eine 304-Antwort gegen das Limit?",
        "messen",
        delta === 0 ? "nein" : `ja (+${String(delta)})`,
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
