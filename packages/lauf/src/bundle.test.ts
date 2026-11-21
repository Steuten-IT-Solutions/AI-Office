import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { BUNDLE_DATEI, erzeugeBundle } from "./bundle.ts";
import type { BundleKonfig } from "./konfig.ts";

const REF = "refs/heads/agent/r-1";
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@aio.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@aio.invalid",
};

function git(cwd: string, ...argumente: string[]): string {
  return execFileSync("git", argumente, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

function commit(cwd: string, datei: string): string {
  writeFileSync(join(cwd, datei), datei);
  git(cwd, "add", datei);
  git(cwd, "commit", "-q", "-m", datei);
  return git(cwd, "rev-parse", "HEAD");
}

let repo: string;
let ausgabe: string;
let basis: string;

function konfig(teil: Partial<BundleKonfig> = {}): BundleKonfig {
  return { arbeitskopie: repo, ref: REF, basis, timeoutMs: 10_000, ...teil };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "aio-lauf-repo-"));
  ausgabe = mkdtempSync(join(tmpdir(), "aio-lauf-aus-"));
  git(repo, "init", "-q", "-b", "main");
  basis = commit(repo, "a.txt");
});

describe("erzeugeBundle", () => {
  it("braucht nichts zu tun, wenn kein Bundle verlangt ist", async () => {
    expect(await erzeugeBundle(null, ausgabe)).toEqual({ status: "nicht_verlangt" });
  });

  it("meldet einen fehlenden Branch", async () => {
    expect(await erzeugeBundle(konfig(), ausgabe)).toEqual({ status: "kein_branch" });
  });

  it("meldet einen Branch ohne neue Commits", async () => {
    git(repo, "branch", "agent/r-1");
    expect(await erzeugeBundle(konfig(), ausgabe)).toEqual({
      status: "keine_aenderung",
      head: basis,
    });
  });

  it("erzeugt ein Bundle nur mit den neuen Commits des vergebenen Branches", async () => {
    git(repo, "checkout", "-q", "-b", "agent/r-1");
    const head = commit(repo, "b.txt");
    git(repo, "checkout", "-q", "-b", "agent/anderer");
    commit(repo, "c.txt");

    const ergebnis = await erzeugeBundle(konfig(), ausgabe);
    const inhalt = readFileSync(join(ausgabe, BUNDLE_DATEI));
    expect(ergebnis).toEqual({
      status: "erstellt",
      datei: BUNDLE_DATEI,
      bytes: inhalt.length,
      sha256: createHash("sha256").update(inhalt).digest("hex"),
      head,
    });
    // Nur der eine Ref, mit der Basis als Voraussetzung.
    const kopfzeilen = git(ausgabe, "bundle", "list-heads", join(ausgabe, BUNDLE_DATEI));
    expect(kopfzeilen).toBe(`${head} ${REF}`);
    const ziel = mkdtempSync(join(tmpdir(), "aio-lauf-ziel-"));
    git(ziel, "init", "-q", "--bare");
    git(ziel, "fetch", "-q", repo, "main");
    expect(git(ziel, "bundle", "verify", "-q", join(ausgabe, BUNDLE_DATEI))).toBe("");
  });

  it("erzeugt ohne Basis ein vollständiges Bundle", async () => {
    git(repo, "checkout", "-q", "-b", "agent/r-1");
    commit(repo, "b.txt");
    const ergebnis = await erzeugeBundle(konfig({ basis: null }), ausgabe);
    expect(ergebnis.status).toBe("erstellt");
    const ziel = mkdtempSync(join(tmpdir(), "aio-lauf-ziel-"));
    git(ziel, "init", "-q", "--bare");
    expect(git(ziel, "bundle", "verify", "-q", join(ausgabe, BUNDLE_DATEI))).toBe("");
  });

  it("entfernt ein altes Bundle, wenn diesmal keines entsteht", async () => {
    writeFileSync(join(ausgabe, BUNDLE_DATEI), "alt");
    await erzeugeBundle(konfig(), ausgabe);
    expect(() => readFileSync(join(ausgabe, BUNDLE_DATEI))).toThrow();
  });

  it("führt keine Hooks aus der Arbeitskopie aus", async () => {
    git(repo, "checkout", "-q", "-b", "agent/r-1");
    commit(repo, "b.txt");
    const marker = join(ausgabe, "hook-lief");
    git(repo, "config", "core.hooksPath", join(repo, "hooks"));
    git(repo, "config", "core.fsmonitor", `touch ${marker}`);
    await erzeugeBundle(konfig(), ausgabe);
    expect(() => readFileSync(marker)).toThrow();
  });

  it("meldet eine unbekannte Basis als Fehler", async () => {
    git(repo, "checkout", "-q", "-b", "agent/r-1");
    commit(repo, "b.txt");
    const ergebnis = await erzeugeBundle(konfig({ basis: "b".repeat(40) }), ausgabe);
    expect(ergebnis.status).toBe("fehler");
  });

  it("meldet eine fehlende Arbeitskopie als Fehler", async () => {
    const ergebnis = await erzeugeBundle(konfig({ arbeitskopie: join(repo, "fehlt") }), ausgabe);
    expect(ergebnis.status).toBe("fehler");
  });
});
