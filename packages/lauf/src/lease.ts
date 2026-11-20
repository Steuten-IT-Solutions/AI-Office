import { spawn } from "node:child_process";

/**
 * Führt das CLI mit harter Wanduhr-Grenze aus (E42, plan.md Kap. 5.7 „Zeitgrenze“).
 *
 * Die Grenze greift ohne Supervisor: Nach Ablauf der Lease bekommt das CLI erst SIGINT, dann
 * SIGTERM, dann wird seine ganze Prozessgruppe per SIGKILL beendet. Dieselbe Kaskade läuft, wenn
 * der Container von außen gestoppt wird (`docker stop` schickt SIGTERM an PID 1, `tini` reicht es
 * an den Startprozess weiter).
 *
 * Ein Agent mit Bash läuft unter derselben UID wie der Startprozess und kann ihn beenden. Das
 * verkürzt den Lauf nur: Endet der Startprozess, endet `tini` und mit ihm der Container samt aller
 * Prozesse. Verlängern kann er den Lauf so nicht.
 */

export type StoppStufe = "SIGINT" | "SIGTERM" | "SIGKILL";

export type Beendigung =
  /** Das CLI hat sich selbst beendet. */
  | "normal"
  /** Die Lease ist abgelaufen. */
  | "lease"
  /** Stop von außen (Supervisor, Notaus). */
  | "stopp";

export interface LaufErgebnis {
  beendet: Beendigung;
  exitCode: number | null;
  signal: string | null;
  /** Letzte Stufe der Kaskade, die nötig war; `null`, wenn keine nötig war. */
  stoppStufe: StoppStufe | null;
  dauerMs: number;
}

export interface LeaseOptionen {
  befehl: string;
  argumente: readonly string[];
  leaseMs: number;
  stoppStufeMs: number;
  /** Stop von außen; löst dieselbe Kaskade aus wie das Ende der Lease. */
  stopp?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Für Tests: Ausgaben sammeln statt durchreichen. */
  stdio?: "inherit" | "pipe";
  /** Nur mit `stdio: "pipe"`: erhält die Ausgabe des CLI. */
  beiAusgabe?: (text: string) => void;
  jetzt?: () => number;
}

export class StartFehler extends Error {
  override readonly name = "StartFehler";
}

function senden(pid: number, signal: NodeJS.Signals, gruppe: boolean): void {
  try {
    process.kill(gruppe ? -pid : pid, signal);
  } catch (fehler) {
    // ESRCH: Prozess oder Gruppe gibt es nicht mehr. Das ist hier das gewünschte Ergebnis.
    if ((fehler as NodeJS.ErrnoException).code !== "ESRCH") {
      throw fehler;
    }
  }
}

export function fuehreAus(optionen: LeaseOptionen): Promise<LaufErgebnis> {
  const jetzt = optionen.jetzt ?? Date.now;
  const start = jetzt();
  return new Promise((resolve, reject) => {
    // Eigene Prozessgruppe, damit SIGKILL auch Kindprozesse des CLI erreicht (Bash, Tests).
    const kind = spawn(optionen.befehl, optionen.argumente, {
      detached: true,
      stdio: optionen.stdio ?? "inherit",
      env: optionen.env ?? process.env,
      cwd: optionen.cwd,
    });
    kind.stdout?.setEncoding("utf8").on("data", (text: string) => optionen.beiAusgabe?.(text));
    kind.stderr?.resume();
    let beendet: Beendigung = "normal";
    let stoppStufe: StoppStufe | null = null;
    const timer: NodeJS.Timeout[] = [];
    let fertig = false;

    const aufraeumen = () => {
      for (const t of timer) clearTimeout(t);
      optionen.stopp?.removeEventListener("abort", beiStopp);
    };

    const kaskade = (grund: Beendigung) => {
      if (stoppStufe !== null || fertig || kind.pid === undefined) {
        return;
      }
      const pid = kind.pid;
      beendet = grund;
      stoppStufe = "SIGINT";
      senden(pid, "SIGINT", false);
      timer.push(
        setTimeout(() => {
          stoppStufe = "SIGTERM";
          senden(pid, "SIGTERM", false);
          timer.push(
            setTimeout(() => {
              stoppStufe = "SIGKILL";
              senden(pid, "SIGKILL", true);
            }, optionen.stoppStufeMs),
          );
        }, optionen.stoppStufeMs),
      );
    };

    function beiStopp() {
      kaskade("stopp");
    }

    kind.once("error", (fehler) => {
      fertig = true;
      aufraeumen();
      reject(new StartFehler(`CLI nicht startbar: ${fehler.message}`));
    });

    kind.once("spawn", () => {
      timer.push(
        setTimeout(() => {
          kaskade("lease");
        }, optionen.leaseMs),
      );
      if (optionen.stopp?.aborted === true) {
        kaskade("stopp");
      } else {
        optionen.stopp?.addEventListener("abort", beiStopp, { once: true });
      }
    });

    kind.once("exit", (exitCode, signal) => {
      fertig = true;
      aufraeumen();
      // Was das CLI zurückgelassen hat (Hintergrundprozesse aus Bash), endet jetzt. Danach
      // verändert niemand mehr die Arbeitskopie, während das Bundle entsteht.
      if (kind.pid !== undefined) {
        senden(kind.pid, "SIGKILL", true);
      }
      resolve({ beendet, exitCode, signal, stoppStufe, dauerMs: jetzt() - start });
    });
  });
}
