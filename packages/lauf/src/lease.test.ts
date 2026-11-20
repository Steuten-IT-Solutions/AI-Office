import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fuehreAus, StartFehler, type LeaseOptionen } from "./lease.ts";

const CLI = join(import.meta.dirname, "test-cli.ts");

function attrappe(
  argumente: string[],
  optionen: Partial<LeaseOptionen> = {},
): ReturnType<typeof fuehreAus> {
  return fuehreAus({
    befehl: process.execPath,
    argumente: [CLI, ...argumente],
    leaseMs: 5000,
    stoppStufeMs: 200,
    stdio: "pipe",
    ...optionen,
  });
}

/** Läuft der Prozess noch? Ein Zombie (Zustand Z, noch nicht abgeholt) zählt als beendet. */
function lebt(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return !/^\d+ \(.*\) Z /.test(stat);
  } catch {
    return false;
  }
}

describe("fuehreAus", () => {
  it("reicht den Exit-Code des CLI durch", async () => {
    const ergebnis = await attrappe(["exit", "3"]);
    expect(ergebnis).toMatchObject({
      beendet: "normal",
      exitCode: 3,
      signal: null,
      stoppStufe: null,
    });
  });

  it("beendet das CLI nach Ablauf der Lease mit SIGINT", async () => {
    const ergebnis = await attrappe(["schlafe", "10000"], { leaseMs: 300 });
    expect(ergebnis).toMatchObject({ beendet: "lease", signal: "SIGINT", stoppStufe: "SIGINT" });
    expect(ergebnis.dauerMs).toBeLessThan(3000);
  });

  it("geht zu SIGTERM, wenn das CLI SIGINT ignoriert", async () => {
    const ergebnis = await attrappe(["ignoriere", "SIGINT", "schlafe", "10000"], {
      leaseMs: 200,
    });
    expect(ergebnis).toMatchObject({ beendet: "lease", signal: "SIGTERM", stoppStufe: "SIGTERM" });
  });

  it("beendet mit SIGKILL, wenn das CLI SIGINT und SIGTERM ignoriert", async () => {
    const ergebnis = await attrappe(["ignoriere", "SIGINT", "SIGTERM", "schlafe", "10000"], {
      leaseMs: 200,
    });
    expect(ergebnis).toMatchObject({ beendet: "lease", signal: "SIGKILL", stoppStufe: "SIGKILL" });
    expect(ergebnis.dauerMs).toBeLessThan(3000);
  });

  it("lässt das CLI sich nach SIGINT selbst beenden", async () => {
    const ergebnis = await attrappe(["beende-bei", "SIGINT", "schlafe", "10000"], {
      leaseMs: 200,
    });
    expect(ergebnis).toMatchObject({ beendet: "lease", exitCode: 7, stoppStufe: "SIGINT" });
  });

  it("startet dieselbe Kaskade bei einem Stop von außen", async () => {
    const stopp = new AbortController();
    const lauf = attrappe(["schlafe", "10000"], { stopp: stopp.signal });
    setTimeout(() => {
      stopp.abort();
    }, 200);
    expect(await lauf).toMatchObject({ beendet: "stopp", stoppStufe: "SIGINT" });
  });

  it("stoppt sofort, wenn der Stop schon vor dem Start kam", async () => {
    const stopp = new AbortController();
    stopp.abort();
    expect(await attrappe(["schlafe", "10000"], { stopp: stopp.signal })).toMatchObject({
      beendet: "stopp",
    });
  });

  it("beendet zurückgelassene Kindprozesse des CLI", async () => {
    let ausgabe = "";
    const ergebnis = await attrappe(["kind"], {
      beiAusgabe: (text) => {
        ausgabe += text;
      },
    });
    expect(ergebnis.exitCode).toBe(0);
    const pid = Number(/enkel (\d+)/.exec(ausgabe)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(lebt(pid)).toBe(false);
  });

  it("meldet ein nicht startbares CLI", async () => {
    await expect(
      fuehreAus({
        befehl: "/nicht/vorhanden",
        argumente: [],
        leaseMs: 1000,
        stoppStufeMs: 100,
        stdio: "pipe",
      }),
    ).rejects.toThrow(StartFehler);
  });
});
