import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Git mit Installations-Token. Das Token steht nur in der Umgebung des Kindprozesses
 * (GIT_CONFIG_*), nicht in der Kommandozeile und nicht in einer Datei.
 */
export function gitEnv(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export interface GitResult {
  ok: boolean;
  output: string;
}

export function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): GitResult {
  try {
    const output = execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
    return { ok: true, output };
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Klont das Test-Repo in ein temporäres Verzeichnis und räumt danach auf. */
export function withClone<T>(
  owner: string,
  repo: string,
  env: NodeJS.ProcessEnv,
  fn: (dir: string) => T,
): T {
  const base = mkdtempSync(join(tmpdir(), "aio-s1-"));
  const dir = join(base, repo);
  try {
    const clone = git(
      ["clone", "--quiet", `https://github.com/${owner}/${repo}.git`, dir],
      base,
      env,
    );
    if (!clone.ok) {
      throw new Error(`Klonen fehlgeschlagen: ${firstLine(clone.output)}`);
    }
    git(["config", "user.name", "aio-spike-s1"], dir, env);
    git(["config", "user.email", "spike@aio.invalid"], dir, env);
    return fn(dir);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** Erste aussagekräftige Zeile einer Git-Ausgabe, ohne Zugangsdaten. */
export function firstLine(output: string): string {
  const line =
    output
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("!") || l.includes("refusing") || l.includes("error")) ??
    output.trim().split("\n")[0] ??
    "";
  return line.replace(/x-access-token:[^@\s]+/g, "x-access-token:***");
}
