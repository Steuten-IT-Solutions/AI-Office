import { ConfigError, configFromEnv } from "./config.ts";
import { consoleLogger, errorText } from "./log.ts";
import { startOffice } from "./office-process.ts";
import { PasswordAborted, passwordCommand } from "./password-command.ts";

/**
 * Einstiegspunkt des Office. Die Unit `aio-office.service` aus dem Supervisor-Repo (S16) startet
 * ihn mit `node /opt/aio-office/current/packages/office/src/main.ts`; Node führt TypeScript
 * direkt aus (Type Stripping), ein Build-Schritt ist nicht nötig.
 *
 *     main.ts            Office starten (Takt, Office-API, Gateway)
 *     main.ts passwort   Passwort des CEO setzen (siehe `password-command.ts`)
 *
 * Einstellungen kommen aus der Umgebung (`config.ts`). SIGTERM und SIGINT beenden das Office
 * geordnet: erst die Server, dann der Takt, zuletzt Socket und Datenbank.
 */

/** Exit-Codes nach `sysexits.h`: 64 falscher Aufruf, 78 Einstellungen ungültig. */
const EXIT_USAGE = 64;
const EXIT_CONFIG = 78;

async function main(args: readonly string[]): Promise<number> {
  let config;
  try {
    config = configFromEnv(process.env);
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`);
    return error instanceof ConfigError ? EXIT_CONFIG : 1;
  }

  if (args[0] === "passwort" && args.length === 1) {
    try {
      await passwordCommand({
        path: config.passwordFile,
        input: process.stdin,
        output: process.stderr,
      });
      return 0;
    } catch (error) {
      process.stderr.write(`${errorText(error)}\n`);
      return error instanceof PasswordAborted ? 130 : 1;
    }
  }
  if (args.length > 0) {
    process.stderr.write("Aufruf: main.ts [passwort]\n");
    return EXIT_USAGE;
  }

  const log = consoleLogger({ level: config.logLevel });
  // Vor dem Start: Ein Signal während des Starts soll das Office danach geordnet beenden, statt
  // den Prozess mit der Standardaktion mitten im Start abzubrechen.
  const received: { signal: string | null; wake: () => void } = {
    signal: null,
    wake: () => undefined,
  };
  const onSignal = (name: string) => () => {
    if (received.signal === null) {
      received.signal = name;
      received.wake();
    }
  };
  process.once("SIGTERM", onSignal("SIGTERM"));
  process.once("SIGINT", onSignal("SIGINT"));

  let office;
  try {
    office = await startOffice(config, { log });
  } catch (error) {
    log.error("Office nicht gestartet", { error: errorText(error) });
    return 1;
  }
  if (received.signal === null) {
    await new Promise<void>((resolve) => {
      received.wake = resolve;
    });
  }
  log.info("Signal empfangen, Office wird beendet", { signal: received.signal });
  await office.stop();
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
// Sicherheitsnetz: Hält nach dem Beenden noch etwas den Prozess offen, endet er trotzdem.
setTimeout(() => {
  process.exit();
}, 2_000).unref();
