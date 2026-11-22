/**
 * Protokoll des Office-Prozesses: eine JSON-Zeile je Eintrag auf stdout bzw. stderr. Unter
 * systemd landet beides im Journal der Unit `aio-office`.
 *
 * Keine Texte von Agenten oder vom CEO ins Protokoll: Es ist für den Betrieb, nicht für Inhalte.
 * Fehlermeldungen können Lauf-IDs, Aufgaben-IDs und Gründe des Supervisors enthalten.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

export function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(ORDER, value);
}

export interface ConsoleLoggerOptions {
  level?: LogLevel;
  now?: () => Date;
  /** Standard: `process.stdout.write` bzw. für `warn` und `error` `process.stderr.write`. */
  write?: (level: LogLevel, line: string) => void;
}

/** Logger mit JSON-Zeilen. Einträge unter `level` fallen weg. */
export function consoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const min = ORDER[options.level ?? "info"];
  const now = options.now ?? (() => new Date());
  const write =
    options.write ??
    ((level: LogLevel, line: string) => {
      (ORDER[level] >= ORDER.warn ? process.stderr : process.stdout).write(line);
    });
  const entry =
    (level: LogLevel) =>
    (message: string, fields: LogFields = {}) => {
      if (ORDER[level] < min) {
        return;
      }
      const line = JSON.stringify({ time: now().toISOString(), level, msg: message, ...fields });
      write(level, `${line}\n`);
    };
  return { debug: entry("debug"), info: entry("info"), warn: entry("warn"), error: entry("error") };
}

/** Text eines Fehlers für das Protokoll. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
