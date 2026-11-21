/**
 * Konfiguration des Startprozesses im Lauf-Container (P12, plan.md Kap. 5.7, E42).
 *
 * Alle Werte setzt der Container-Manager des Supervisors (S05) als Umgebungsvariablen. Der
 * Startprozess prüft sie streng und startet bei einem Fehler gar nichts: Ein Lauf ohne gültige
 * Lease darf nicht beginnen.
 */

/** Obergrenze für eine Lease. Ein Lauf, der länger dauern soll, ist ein Konfigurationsfehler. */
export const MAX_LEASE_SEKUNDEN = 6 * 60 * 60;
/** Obergrenze je Stufe der Stop-Kaskade (SIGINT, SIGTERM). */
export const MAX_STOPP_STUFE_SEKUNDEN = 120;
/** Obergrenze für die Bundle-Erzeugung nach dem Lauf. */
export const MAX_BUNDLE_SEKUNDEN = 600;

export interface LaufKonfig {
  laufId: string;
  /** Harte Wanduhr-Grenze ab Start des Startprozesses (E42). */
  leaseMs: number;
  /** Wartezeit je Stufe der Kaskade SIGINT → SIGTERM → SIGKILL (plan.md Kap. 5.7). */
  stoppStufeMs: number;
  /** Verzeichnis für `ergebnis.json` und `lauf.bundle`; liest der Supervisor nach dem Lauf. */
  ausgabe: string;
  /** Nur bei `werkbank`: Arbeitskopie und der eine vom Supervisor vergebene Ref (Kap. 4.5 Nr. 1). */
  bundle: BundleKonfig | null;
  /** Aufruf des CLI, so wie ihn der Supervisor gebaut hat (E25). */
  befehl: string;
  argumente: string[];
}

export interface BundleKonfig {
  arbeitskopie: string;
  ref: string;
  /** Stand von `main` beim Klonen; das Bundle enthält dann nur die neuen Commits. */
  basis: string | null;
  timeoutMs: number;
}

export class KonfigFehler extends Error {
  override readonly name = "KonfigFehler";
}

const LAUF_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Branch-Namen vergibt der Supervisor, z. B. `agent/r-7f3a9c` (plan.md Kap. 4.5 Nr. 1, E14). */
const AGENT_REF = /^refs\/heads\/agent\/[a-z0-9][a-z0-9-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;
const GANZZAHL = /^[1-9][0-9]{0,9}$/;
const ABSOLUTER_PFAD = /^\/[^\0]*$/;

type Umgebung = Readonly<Record<string, string | undefined>>;

function pflicht(env: Umgebung, name: string): string {
  const wert = env[name];
  if (wert === undefined || wert === "") {
    throw new KonfigFehler(`${name} fehlt`);
  }
  return wert;
}

function sekunden(env: Umgebung, name: string, max: number, standard?: number): number {
  const roh = env[name];
  if (roh === undefined || roh === "") {
    if (standard === undefined) {
      throw new KonfigFehler(`${name} fehlt`);
    }
    return standard * 1000;
  }
  if (!GANZZAHL.test(roh)) {
    throw new KonfigFehler(`${name} ist keine positive ganze Zahl`);
  }
  const wert = Number(roh);
  if (wert > max) {
    throw new KonfigFehler(`${name} liegt über ${String(max)}`);
  }
  return wert * 1000;
}

function pfad(env: Umgebung, name: string, standard?: string): string {
  const wert = env[name] ?? standard;
  if (wert === undefined || wert === "") {
    throw new KonfigFehler(`${name} fehlt`);
  }
  if (!ABSOLUTER_PFAD.test(wert) || wert.split("/").includes("..")) {
    throw new KonfigFehler(`${name} ist kein absoluter Pfad ohne ".."`);
  }
  return wert;
}

/**
 * Liest die Konfiguration aus Umgebung und Argumenten.
 *
 * `argv` ist der Aufruf des CLI, z. B. `["claude", "-p", ...]`. Er kommt als `CMD` des Containers.
 */
export function leseKonfig(env: Umgebung, argv: readonly string[]): LaufKonfig {
  const laufId = pflicht(env, "AIO_LAUF_ID");
  if (!LAUF_ID.test(laufId)) {
    throw new KonfigFehler("AIO_LAUF_ID hat ein ungültiges Format");
  }
  const leaseMs = sekunden(env, "AIO_LEASE_SEKUNDEN", MAX_LEASE_SEKUNDEN);
  const stoppStufeMs = sekunden(env, "AIO_STOPP_STUFE_SEKUNDEN", MAX_STOPP_STUFE_SEKUNDEN, 10);
  const ausgabe = pfad(env, "AIO_AUSGABE", "/aio/ausgabe");

  let bundle: BundleKonfig | null = null;
  const arbeitskopie = env["AIO_ARBEITSKOPIE"];
  const ref = env["AIO_BUNDLE_REF"];
  if (arbeitskopie !== undefined && arbeitskopie !== "") {
    if (ref === undefined || !AGENT_REF.test(ref)) {
      throw new KonfigFehler("AIO_BUNDLE_REF fehlt oder ist kein Ref unter refs/heads/agent/");
    }
    const basis = env["AIO_BUNDLE_BASIS"];
    if (basis !== undefined && basis !== "" && !SHA.test(basis)) {
      throw new KonfigFehler("AIO_BUNDLE_BASIS ist keine vollständige SHA-1");
    }
    bundle = {
      arbeitskopie: pfad(env, "AIO_ARBEITSKOPIE"),
      ref,
      basis: basis === undefined || basis === "" ? null : basis,
      timeoutMs: sekunden(env, "AIO_BUNDLE_SEKUNDEN", MAX_BUNDLE_SEKUNDEN, 120),
    };
  } else if (ref !== undefined && ref !== "") {
    throw new KonfigFehler("AIO_BUNDLE_REF ohne AIO_ARBEITSKOPIE");
  }

  const [befehl, ...argumente] = argv;
  if (befehl === undefined || befehl === "") {
    throw new KonfigFehler("Kein Befehl angegeben");
  }
  return { laufId, leaseMs, stoppStufeMs, ausgabe, bundle, befehl, argumente };
}
