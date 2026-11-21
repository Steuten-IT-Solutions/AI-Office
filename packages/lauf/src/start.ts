import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { erzeugeBundle, type BundleErgebnis } from "./bundle.ts";
import { KonfigFehler, leseKonfig, type LaufKonfig } from "./konfig.ts";
import { fuehreAus, StartFehler, type LaufErgebnis } from "./lease.ts";
import { MANAGED_SETTINGS, pruefeManagedSettings } from "./richtlinie.ts";

/**
 * Startprozess des Lauf-Containers (P12): Lease, Stop-Kaskade, Bundle, Ergebnisdatei.
 *
 * Aufruf im Image: `tini -- node /opt/aio-lauf/start.ts claude -p ...`. Die Ausgabe des CLI
 * (`stream-json`) geht unverändert nach stdout, der Startprozess selbst schreibt nur nach stderr
 * und in `ergebnis.json`. Exit-Codes: der des CLI, 124 nach Ablauf der Lease (wie `timeout`),
 * 125 bei ungültiger Konfiguration oder fehlenden Managed Settings, 126 wenn das CLI nicht startet.
 */

export const ERGEBNIS_DATEI = "ergebnis.json";
export const EXIT_LEASE = 124;
export const EXIT_KONFIG = 125;
export const EXIT_START = 126;

export interface Ergebnis {
  version: 1;
  laufId: string;
  lauf: LaufErgebnis | null;
  bundle: BundleErgebnis;
  fehler: string | null;
}

/** Umgebung des CLI: alles außer den Steuerwerten des Startprozesses. */
export function cliUmgebung(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const ergebnis: NodeJS.ProcessEnv = {};
  for (const [name, wert] of Object.entries(env)) {
    if (!name.startsWith("AIO_")) {
      ergebnis[name] = wert;
    }
  }
  return ergebnis;
}

async function schreibeErgebnis(ausgabe: string, ergebnis: Ergebnis): Promise<void> {
  await mkdir(ausgabe, { recursive: true });
  const ziel = join(ausgabe, ERGEBNIS_DATEI);
  const tmp = `${ziel}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ergebnis)}\n`, { mode: 0o644 });
  await rename(tmp, ziel);
}

export function exitCode(lauf: LaufErgebnis): number {
  if (lauf.beendet === "lease") {
    return EXIT_LEASE;
  }
  if (lauf.exitCode !== null) {
    return lauf.exitCode;
  }
  // Durch ein Signal beendet: Konvention der Shells, 128 + Signalnummer. Nummern nach Linux.
  const nummern: Record<string, number> = { SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
  return 128 + (lauf.signal === null ? 0 : (nummern[lauf.signal] ?? 0));
}

export interface StartOptionen {
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  stopp: AbortSignal;
  stdio?: "inherit" | "pipe";
  log?: (zeile: string) => void;
  /** Pfad der Managed Settings; nur Tests weichen vom Ort im Container ab. */
  managedSettings?: string;
}

/** Führt einen Lauf vollständig aus und liefert den Exit-Code des Containers. */
export async function starte(optionen: StartOptionen): Promise<number> {
  const log = optionen.log ?? ((zeile: string) => process.stderr.write(`${zeile}\n`));
  let konfig: LaufKonfig;
  try {
    konfig = leseKonfig(optionen.env, optionen.argv);
    pruefeManagedSettings(optionen.managedSettings ?? MANAGED_SETTINGS);
  } catch (fehler) {
    if (fehler instanceof KonfigFehler) {
      log(`aio-lauf: Konfiguration ungültig: ${fehler.message}`);
      return EXIT_KONFIG;
    }
    throw fehler;
  }

  let lauf: LaufErgebnis;
  try {
    const ausfuehrung: Parameters<typeof fuehreAus>[0] = {
      befehl: konfig.befehl,
      argumente: konfig.argumente,
      leaseMs: konfig.leaseMs,
      stoppStufeMs: konfig.stoppStufeMs,
      stopp: optionen.stopp,
      env: cliUmgebung(optionen.env),
    };
    if (optionen.stdio !== undefined) {
      ausfuehrung.stdio = optionen.stdio;
    }
    lauf = await fuehreAus(ausfuehrung);
  } catch (fehler) {
    if (fehler instanceof StartFehler) {
      log(`aio-lauf: ${fehler.message}`);
      await schreibeErgebnis(konfig.ausgabe, {
        version: 1,
        laufId: konfig.laufId,
        lauf: null,
        bundle: { status: "nicht_verlangt" },
        fehler: fehler.message,
      });
      return EXIT_START;
    }
    throw fehler;
  }

  // Auch nach Ablauf der Lease: Die Commits bis dahin gehören zum Lauf. Ob sie hinausgehen,
  // entscheidet das Git-Gate. Die Bundle-Erzeugung hat ihre eigene Zeitgrenze.
  let bundle: BundleErgebnis;
  try {
    bundle = await erzeugeBundle(konfig.bundle, konfig.ausgabe);
  } catch (fehler) {
    bundle = { status: "fehler", fehler: (fehler as Error).message.slice(0, 300) };
  }
  await schreibeErgebnis(konfig.ausgabe, {
    version: 1,
    laufId: konfig.laufId,
    lauf,
    bundle,
    fehler: null,
  });
  log(`aio-lauf: beendet=${lauf.beendet} stufe=${lauf.stoppStufe ?? "-"} bundle=${bundle.status}`);
  return exitCode(lauf);
}

/** Einstieg im Container. */
export async function main(): Promise<void> {
  const stopp = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      stopp.abort();
    });
  }
  const code = await starte({ env: process.env, argv: process.argv.slice(2), stopp: stopp.signal });
  process.exit(code);
}

if (import.meta.main) {
  await main();
}
