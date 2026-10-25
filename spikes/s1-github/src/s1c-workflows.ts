/**
 * Spike S1c: Lehnt GitHub Änderungen an `.github/workflows/` ab, wenn die App keine
 * Berechtigung „Workflows“ hat? (plan.md Fakt 17, Annahme)
 *
 * Alle Versuche laufen auf einem eigenen Branch im Test-Repo. Die Workflow-Datei reagiert nur
 * auf `workflow_dispatch` und würde selbst bei einem erfolgreichen Push nicht automatisch laufen.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { api, installationToken, loadConfig, message } from "./github.ts";
import { firstLine, git, gitEnv, withClone } from "./git.ts";
import { Report } from "./report.ts";

const EXISTING_WORKFLOW = ".github/workflows/existing.yml";
const WORKFLOW_CONTENT = `name: s1c\non: workflow_dispatch\njobs:\n  noop:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo s1c\n`;

const rejected = (status: number) => status >= 400;

async function main(): Promise<void> {
  const config = loadConfig();
  const token = await installationToken(config);
  const repoPath = `/repos/${config.owner}/${config.repo}`;
  const report = new Report("S1c – Workflow-Dateien ohne Berechtigung „Workflows“");
  const branch = `spike/s1c-${String(Date.now())}`;

  const repo = await api(token, "GET", repoPath);
  const defaultBranch = (repo.body as { default_branch: string }).default_branch;
  const head = await api(token, "GET", `${repoPath}/git/ref/heads/${defaultBranch}`);
  const baseSha = (head.body as { object: { sha: string } }).object.sha;

  const created = await api(token, "POST", `${repoPath}/git/refs`, {
    body: { ref: `refs/heads/${branch}`, sha: baseSha },
  });
  report.add(
    "Kontrolle: Branch per API anlegen",
    "erlaubt (201)",
    `HTTP ${String(created.status)}`,
    created.status === 201,
  );
  if (created.status !== 201) {
    report.write("s1c-bericht.md");
    process.exitCode = 1;
    return;
  }

  try {
    const env = gitEnv(token);
    withClone(config.owner, config.repo, env, (dir) => {
      git(["checkout", "--quiet", branch], dir, env);

      writeFileSync(join(dir, "kontrolle.txt"), "s1c\n");
      git(["add", "kontrolle.txt"], dir, env);
      git(["commit", "--quiet", "-m", "s1c: Kontrolle"], dir, env);
      const control = git(["push", "--quiet", "origin", branch], dir, env);
      report.add(
        "Kontrolle: normale Datei per git push",
        "erlaubt",
        control.ok ? "erlaubt" : `abgelehnt: ${firstLine(control.output)}`,
        control.ok,
      );

      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(join(dir, ".github", "workflows", "s1c-git.yml"), WORKFLOW_CONTENT);
      git(["add", ".github/workflows/s1c-git.yml"], dir, env);
      git(["commit", "--quiet", "-m", "s1c: Workflow per git"], dir, env);
      const push = git(["push", "--quiet", "origin", branch], dir, env);
      report.add(
        "Neue Workflow-Datei per git push",
        "abgelehnt",
        push.ok ? "ERLAUBT" : `abgelehnt: ${firstLine(push.output)}`,
        !push.ok,
      );
    });

    const put = await api(token, "PUT", `${repoPath}/contents/.github/workflows/s1c-api.yml`, {
      body: {
        message: "s1c: Workflow per Contents-API",
        content: Buffer.from(WORKFLOW_CONTENT).toString("base64"),
        branch,
      },
    });
    report.add(
      "Neue Workflow-Datei per Contents-API",
      "abgelehnt (4xx)",
      `HTTP ${String(put.status)} ${message(put)}`,
      rejected(put.status),
    );

    const existing = await api(
      token,
      "GET",
      `${repoPath}/contents/${EXISTING_WORKFLOW}?ref=${encodeURIComponent(branch)}`,
    );
    if (existing.status === 200) {
      const sha = (existing.body as { sha: string }).sha;
      const update = await api(token, "PUT", `${repoPath}/contents/${EXISTING_WORKFLOW}`, {
        body: {
          message: "s1c: bestehenden Workflow ändern",
          content: Buffer.from(`${WORKFLOW_CONTENT}# geändert\n`).toString("base64"),
          sha,
          branch,
        },
      });
      report.add(
        "Bestehende Workflow-Datei per Contents-API ändern",
        "abgelehnt (4xx)",
        `HTTP ${String(update.status)} ${message(update)}`,
        rejected(update.status),
      );
      const remove = await api(token, "DELETE", `${repoPath}/contents/${EXISTING_WORKFLOW}`, {
        body: { message: "s1c: bestehenden Workflow löschen", sha, branch },
      });
      report.add(
        "Bestehende Workflow-Datei per Contents-API löschen",
        "abgelehnt (4xx)",
        `HTTP ${String(remove.status)} ${message(remove)}`,
        rejected(remove.status),
      );
    } else {
      report.add(
        "Bestehende Workflow-Datei",
        `${EXISTING_WORKFLOW} vorhanden`,
        `nicht gefunden (HTTP ${String(existing.status)}), Einrichtungsschritt im README fehlt`,
        false,
      );
    }

    const branchHead = await api(token, "GET", `${repoPath}/git/ref/heads/${branch}`);
    const parentSha = (branchHead.body as { object: { sha: string } }).object.sha;
    const parent = await api(token, "GET", `${repoPath}/git/commits/${parentSha}`);
    const parentTree = (parent.body as { tree: { sha: string } }).tree.sha;
    const tree = await api(token, "POST", `${repoPath}/git/trees`, {
      body: {
        base_tree: parentTree,
        tree: [
          {
            path: ".github/workflows/s1c-gitdata.yml",
            mode: "100644",
            type: "blob",
            content: WORKFLOW_CONTENT,
          },
        ],
      },
    });
    let gitDataObserved = `Tree: HTTP ${String(tree.status)} ${message(tree)}`;
    let gitDataRejected = rejected(tree.status);
    if (tree.status === 201) {
      const commit = await api(token, "POST", `${repoPath}/git/commits`, {
        body: {
          message: "s1c: Workflow per Git-Data-API",
          tree: (tree.body as { sha: string }).sha,
          parents: [parentSha],
        },
      });
      gitDataObserved += `; Commit: HTTP ${String(commit.status)}`;
      if (commit.status === 201) {
        const update = await api(token, "PATCH", `${repoPath}/git/refs/heads/${branch}`, {
          body: { sha: (commit.body as { sha: string }).sha },
        });
        gitDataObserved += `; Ref: HTTP ${String(update.status)} ${message(update)}`;
        gitDataRejected = rejected(update.status);
      } else {
        gitDataRejected = true;
      }
    }
    report.add(
      "Neue Workflow-Datei per Git-Data-API (Tree, Commit, Ref)",
      "spätestens beim Ref abgelehnt",
      gitDataObserved,
      gitDataRejected,
    );
  } finally {
    const removed = await api(token, "DELETE", `${repoPath}/git/refs/heads/${branch}`);
    report.add("Aufräumen: Test-Branch löschen", "204", `HTTP ${String(removed.status)}`, null);
  }

  report.write("s1c-bericht.md");
  if (!report.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
