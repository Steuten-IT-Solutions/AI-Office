/**
 * Spike S1e: Kann die App trotz Branch-Schutz nur mit einem Approve des CEO auf dem aktuellen
 * Head-SHA mergen? Muss die App dafür in „Restrict who can push to matching branches“ stehen?
 *
 * Interaktiv: Das Skript fordert den CEO an den passenden Stellen auf, in GitHub zu approven
 * oder eine Einstellung zu ändern. Voraussetzungen stehen im README.
 */
import { createInterface } from "node:readline/promises";
import { api, installationToken, loadConfig, message, type ApiResponse } from "./github.ts";
import { Report } from "./report.ts";

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`\n>>> ${question}\n`)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

const merged = (r: ApiResponse) => r.status === 200;

async function main(): Promise<void> {
  const config = loadConfig();
  const token = await installationToken(config);
  const repoPath = `/repos/${config.owner}/${config.repo}`;
  const report = new Report("S1e – Merge der App unter Branch-Schutz");
  const branch = `spike/s1e-${String(Date.now())}`;
  let prNumber: number | null = null;

  const repo = await api(token, "GET", repoPath);
  const defaultBranch = (repo.body as { default_branch: string }).default_branch;
  const protection = await api(token, "GET", `${repoPath}/branches/${defaultBranch}`);
  const isProtected = (protection.body as { protected?: boolean }).protected === true;
  report.add(
    `Branch-Schutz auf ${defaultBranch} aktiv`,
    "ja (Einrichtung laut README)",
    isProtected ? "ja" : "nein",
    isProtected,
  );
  if (!isProtected) {
    report.write("s1e-bericht.md");
    process.exitCode = 1;
    return;
  }

  const putFile = async (name: string): Promise<string> => {
    const file = await api(token, "PUT", `${repoPath}/contents/${name}`, {
      body: {
        message: `s1e: ${name}`,
        content: Buffer.from(`${name}\n`).toString("base64"),
        branch,
      },
    });
    if (file.status !== 201) {
      throw new Error(`Datei ${name} nicht angelegt (HTTP ${String(file.status)})`);
    }
    return (file.body as { commit: { sha: string } }).commit.sha;
  };
  const merge = (sha: string) =>
    api(token, "PUT", `${repoPath}/pulls/${String(prNumber)}/merge`, {
      body: { sha, merge_method: "merge" },
    });

  try {
    const head = await api(token, "GET", `${repoPath}/git/ref/heads/${defaultBranch}`);
    const baseSha = (head.body as { object: { sha: string } }).object.sha;
    await api(token, "POST", `${repoPath}/git/refs`, {
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
    });
    const firstSha = await putFile(`s1e-${branch.slice(-6)}-a.txt`);
    const pr = await api(token, "POST", `${repoPath}/pulls`, {
      body: { title: "s1e Test", head: branch, base: defaultBranch },
    });
    if (pr.status !== 201) {
      throw new Error(`PR nicht angelegt (HTTP ${String(pr.status)} ${message(pr)})`);
    }
    prNumber = (pr.body as { number: number }).number;
    const prUrl = (pr.body as { html_url: string }).html_url;

    const noApproval = await merge(firstSha);
    report.add(
      "Merge ohne Approve",
      "abgelehnt",
      `HTTP ${String(noApproval.status)} ${message(noApproval)}`,
      !merged(noApproval),
    );

    await ask(`Bitte ${prUrl} in GitHub mit „Approve“ freigeben, dann Enter drücken.`);
    const secondSha = await putFile(`s1e-${branch.slice(-6)}-b.txt`);
    const stale = await merge(secondSha);
    report.add(
      "Merge nach neuem Commit (Approve veraltet)",
      "abgelehnt",
      `HTTP ${String(stale.status)} ${message(stale)}`,
      !merged(stale),
    );

    await ask(`Bitte ${prUrl} erneut mit „Approve“ freigeben (neuer Head), dann Enter drücken.`);
    const oldSha = await merge(firstSha);
    report.add(
      "Merge mit veraltetem SHA im Parameter `sha`",
      "abgelehnt (409)",
      `HTTP ${String(oldSha.status)} ${message(oldSha)}`,
      !merged(oldSha),
    );

    const restricted = await merge(secondSha);
    report.add(
      "Merge mit Approve auf aktuellem SHA, App NICHT in „Restrict who can push“",
      "messen",
      merged(restricted)
        ? "gemergt"
        : `abgelehnt: HTTP ${String(restricted.status)} ${message(restricted)}`,
      null,
    );

    if (!merged(restricted)) {
      await ask(
        "Bitte in den Branch-Schutz-Einstellungen die App unter „Restrict who can push to matching branches“ eintragen, dann Enter drücken.",
      );
      const allowed = await merge(secondSha);
      report.add(
        "Merge mit Approve auf aktuellem SHA, App in „Restrict who can push“",
        "gemergt",
        merged(allowed) ? "gemergt" : `HTTP ${String(allowed.status)} ${message(allowed)}`,
        merged(allowed),
      );
    }
  } finally {
    if (prNumber !== null) {
      const state = await api(token, "GET", `${repoPath}/pulls/${String(prNumber)}`);
      if ((state.body as { merged?: boolean }).merged !== true) {
        await api(token, "PATCH", `${repoPath}/pulls/${String(prNumber)}`, {
          body: { state: "closed" },
        });
      }
    }
    await api(token, "DELETE", `${repoPath}/git/refs/heads/${branch}`);
  }

  report.write("s1e-bericht.md");
  if (!report.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
