import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cliUmgebung,
  ERGEBNIS_DATEI,
  EXIT_KONFIG,
  EXIT_LEASE,
  EXIT_START,
  exitCode,
  starte,
  type Ergebnis,
} from "./start.ts";

const CLI = join(import.meta.dirname, "test-cli.ts");

let ausgabe: string;
let log: string[];

beforeEach(() => {
  ausgabe = mkdtempSync(join(tmpdir(), "aio-lauf-start-"));
  log = [];
});

function env(teil: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"],
    AIO_LAUF_ID: "r-1",
    AIO_LEASE_SEKUNDEN: "5",
    AIO_STOPP_STUFE_SEKUNDEN: "1",
    AIO_AUSGABE: ausgabe,
    ...teil,
  };
}

function lauf(argv: string[], umgebung = env()): Promise<number> {
  return starte({
    env: umgebung,
    argv,
    stopp: new AbortController().signal,
    stdio: "pipe",
    log: (zeile) => log.push(zeile),
  });
}

function ergebnis(): Ergebnis {
  return JSON.parse(readFileSync(join(ausgabe, ERGEBNIS_DATEI), "utf8")) as Ergebnis;
}

describe("starte", () => {
  it("schreibt das Ergebnis eines normalen Laufs", async () => {
    expect(await lauf([process.execPath, CLI, "exit", "0"])).toBe(0);
    expect(ergebnis()).toMatchObject({
      version: 1,
      laufId: "r-1",
      lauf: { beendet: "normal", exitCode: 0 },
      bundle: { status: "nicht_verlangt" },
      fehler: null,
    });
    expect(log.at(-1)).toContain("beendet=normal");
  });

  it("endet nach Ablauf der Lease mit 124", async () => {
    const code = await lauf(
      [process.execPath, CLI, "schlafe", "20000"],
      env({ AIO_LEASE_SEKUNDEN: "1" }),
    );
    expect(code).toBe(EXIT_LEASE);
    expect(ergebnis().lauf).toMatchObject({ beendet: "lease", stoppStufe: "SIGINT" });
  });

  it("startet bei ungültiger Konfiguration nichts", async () => {
    expect(await lauf([process.execPath, CLI], env({ AIO_LEASE_SEKUNDEN: "" }))).toBe(EXIT_KONFIG);
    expect(log[0]).toContain("AIO_LEASE_SEKUNDEN fehlt");
    expect(() => ergebnis()).toThrow();
  });

  it("meldet ein nicht startbares CLI", async () => {
    expect(await lauf(["/nicht/vorhanden"])).toBe(EXIT_START);
    const geschrieben = ergebnis();
    expect(geschrieben.lauf).toBeNull();
    expect(geschrieben.fehler).toContain("nicht startbar");
  });

  it("gibt dem CLI keine Steuerwerte des Startprozesses mit", () => {
    expect(
      cliUmgebung({ AIO_LAUF_ID: "r-1", AIO_BUNDLE_REF: "x", PATH: "/bin", HOME: "/h" }),
    ).toEqual({ PATH: "/bin", HOME: "/h" });
  });

  it("vermerkt ein fehlgeschlagenes Bundle, ohne den Exit-Code zu ändern", async () => {
    const code = await lauf(
      [process.execPath, CLI, "exit", "0"],
      env({
        AIO_ARBEITSKOPIE: join(ausgabe, "fehlt"),
        AIO_BUNDLE_REF: "refs/heads/agent/r-1",
      }),
    );
    expect(code).toBe(0);
    expect(ergebnis().bundle.status).toBe("fehler");
  });
});

describe("exitCode", () => {
  const basis = { beendet: "normal" as const, stoppStufe: null, dauerMs: 1 };
  it("übernimmt den Code des CLI", () => {
    expect(exitCode({ ...basis, exitCode: 2, signal: null })).toBe(2);
  });
  it("rechnet ein Signal nach Shell-Konvention um", () => {
    expect(exitCode({ ...basis, exitCode: null, signal: "SIGKILL" })).toBe(137);
  });
  it("meldet die Lease immer mit 124", () => {
    expect(exitCode({ ...basis, beendet: "lease", exitCode: 0, signal: null })).toBe(124);
  });
});
