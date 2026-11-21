import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BundleKonfig } from "./konfig.ts";

/**
 * Erzeugt am Laufende das `git bundle` für den Supervisor (E28, plan.md Kap. 5.7 „Git“).
 *
 * Das Bundle enthält nur den einen Ref, den der Supervisor vergeben hat. Ob er stimmt, was darin
 * steht und wer die Commits geschrieben hat, prüft erst das Git-Gate (S08); für den Supervisor ist
 * das Bundle wie alles aus dem Container nicht vertrauenswürdig.
 *
 * Git läuft hier im Container, nicht auf dem Host. Die Arbeitskopie gehört dem Agenten, also auch
 * ihre `.git/config`. Hooks und Systemkonfiguration sind trotzdem abgeschaltet, damit ein Lauf
 * nicht versehentlich eigene Skripte in den Abschluss einbaut; eine Sicherheitsgrenze ist das
 * nicht.
 */

export const BUNDLE_DATEI = "lauf.bundle";

export type BundleErgebnis =
  | { status: "nicht_verlangt" }
  | { status: "erstellt"; datei: string; bytes: number; sha256: string; head: string }
  /** Der vergebene Branch existiert in der Arbeitskopie nicht. */
  | { status: "kein_branch" }
  /** Der Branch enthält keinen Commit über die Basis hinaus. */
  | { status: "keine_aenderung"; head: string }
  | { status: "fehler"; fehler: string };

interface GitAusgabe {
  code: number | null;
  stdout: string;
  stderr: string;
}

const GIT_UMGEBUNG: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

const SICHERE_OPTIONEN = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "safe.directory=*",
];

function git(arbeitskopie: string, argumente: string[], timeoutMs: number): Promise<GitAusgabe> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...SICHERE_OPTIONEN, "-C", arbeitskopie, ...argumente],
      { env: GIT_UMGEBUNG, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      (fehler, stdout, stderr) => {
        const code = fehler === null ? 0 : typeof fehler.code === "number" ? fehler.code : null;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function kurz(text: string): string {
  const zeile = text.trim().split("\n").at(-1) ?? "";
  return zeile.slice(0, 300);
}

export async function erzeugeBundle(
  konfig: BundleKonfig | null,
  ausgabe: string,
): Promise<BundleErgebnis> {
  if (konfig === null) {
    return { status: "nicht_verlangt" };
  }
  const datei = join(ausgabe, BUNDLE_DATEI);
  // Ein Bundle aus einem früheren Versuch darf nicht als Ergebnis dieses Laufs gelten.
  await rm(datei, { force: true });

  const kopf = await git(
    konfig.arbeitskopie,
    ["rev-parse", "--verify", "--quiet", `${konfig.ref}^{commit}`],
    konfig.timeoutMs,
  );
  if (kopf.code === 1) {
    return { status: "kein_branch" };
  }
  if (kopf.code !== 0) {
    return { status: "fehler", fehler: `rev-parse: ${kurz(kopf.stderr) || "Abbruch"}` };
  }
  const head = kopf.stdout.trim();

  if (konfig.basis !== null) {
    const neu = await git(
      konfig.arbeitskopie,
      ["rev-list", "--count", `${konfig.basis}..${head}`],
      konfig.timeoutMs,
    );
    if (neu.code !== 0) {
      return { status: "fehler", fehler: `rev-list: ${kurz(neu.stderr) || "Abbruch"}` };
    }
    if (neu.stdout.trim() === "0") {
      return { status: "keine_aenderung", head };
    }
  }

  const bereich = konfig.basis === null ? [konfig.ref] : [konfig.ref, `^${konfig.basis}`];
  const erstellt = await git(
    konfig.arbeitskopie,
    ["bundle", "create", datei, ...bereich],
    konfig.timeoutMs,
  );
  if (erstellt.code !== 0) {
    await rm(datei, { force: true });
    return { status: "fehler", fehler: `bundle create: ${kurz(erstellt.stderr) || "Abbruch"}` };
  }
  const inhalt = await readFile(datei);
  const { size } = await stat(datei);
  return {
    status: "erstellt",
    datei: BUNDLE_DATEI,
    bytes: size,
    sha256: createHash("sha256").update(inhalt).digest("hex"),
    head,
  };
}
