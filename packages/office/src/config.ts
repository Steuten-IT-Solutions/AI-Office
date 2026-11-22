import { isAbsolute } from "node:path";
import { DEFAULT_SOCKET_PATH } from "./ipc/client.ts";
import { checkConsoleUrl } from "./gateway/views.ts";
import { isLogLevel, type LogLevel } from "./log.ts";

/**
 * Einstellungen des Office-Prozesses. Die Standardwerte passen zur Einrichtung des Hosts durch das
 * Supervisor-Repo (`host/provision.sh`, S16); Umgebungsvariablen überschreiben sie, etwa für die
 * Entwicklung.
 *
 * Beide Server lauschen nur auf `127.0.0.1` und sind nicht einstellbar: Das Office öffnet keine
 * Ports nach außen (E41). Das Webinterface erreicht der CEO über den Reverse-Proxy des
 * Supervisors (S13), die Office-API ein Lauf-Container über die Weiterleitung des Supervisors
 * (S05).
 */

export const LISTEN_ADDRESS = "127.0.0.1";

export interface OfficeConfig {
  /** Ereignisprotokoll. Der Supervisor sichert dieselbe Datei (`backup.officeDbPath`, S15). */
  dbPath: string;
  /** scrypt-Hash des CEO-Passworts (P09), geschrieben mit `main.ts passwort`. */
  passwordFile: string;
  /** Text der Verfassung (Kap. 4.1). Ohne ihn startet das Office nicht. */
  constitutionPath: string;
  /** Socket des Supervisors (Kap. 4.7). */
  socketPath: string;
  /** Name des Webinterface, wie ihn der Reverse-Proxy im Header `Host` weitergibt. */
  webHost: string;
  /** Port des Office-Gateways auf `127.0.0.1` (`webProxy.upstreamPort` im Supervisor). */
  gatewayPort: number;
  /** Port der Office-API auf `127.0.0.1` (`runs.officeApi.upstreamPort` im Supervisor). */
  apiPort: number;
  /** Link zur Supervisor-Konsole im Webinterface, `null` ohne Link. */
  consoleUrl: string | null;
  logLevel: LogLevel;
}

export const DEFAULT_OFFICE_CONFIG: Readonly<OfficeConfig> = Object.freeze({
  dbPath: "/var/lib/aio-office/office.db",
  passwordFile: "/var/lib/aio-office/ceo-passwort",
  // Liest das Office, schreibt der Supervisor; `/opt/aio-office` gehört aio-sup (S16).
  // [Annahme: Pfad; die Datei richtet das Supervisor-Repo ein]
  constitutionPath: "/opt/aio-office/verfassung.md",
  socketPath: DEFAULT_SOCKET_PATH,
  // `office.aio.internal` und Port 8444 wie in `host/provision.sh`.
  webHost: "office.aio.internal:8444",
  // Wie `OFFICE_UPSTREAM_PORT` in `host/provision.sh`.
  gatewayPort: 8080,
  // Wie das Beispiel `runs.officeApi.upstreamPort` im README des Supervisor-Repos. [Annahme]
  apiPort: 3000,
  // `konsole.aio-sup.internal` und Port 8443 wie in `host/provision.sh`.
  consoleUrl: "https://konsole.aio-sup.internal:8443/",
  logLevel: "info",
});

/** Umgebungsvariablen und die Einstellung, die sie überschreiben. */
export const CONFIG_ENV: Readonly<Record<string, keyof OfficeConfig>> = Object.freeze({
  AIO_OFFICE_DB: "dbPath",
  AIO_OFFICE_PASSWORT_DATEI: "passwordFile",
  AIO_OFFICE_VERFASSUNG: "constitutionPath",
  AIO_SUPERVISOR_SOCKET: "socketPath",
  AIO_OFFICE_HOST: "webHost",
  AIO_OFFICE_GATEWAY_PORT: "gatewayPort",
  AIO_OFFICE_API_PORT: "apiPort",
  AIO_OFFICE_KONSOLE: "consoleUrl",
  AIO_OFFICE_LOG: "logLevel",
});

export class ConfigError extends Error {
  override name = "ConfigError";
}

const HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;

/**
 * Liest die Einstellungen aus der Umgebung. Unbekannte Variablen mit Präfix `AIO_OFFICE_` sind
 * ein Fehler, damit ein Tippfehler nicht still den Standardwert lässt.
 */
export function configFromEnv(env: Readonly<Record<string, string | undefined>>): OfficeConfig {
  const config: OfficeConfig = { ...DEFAULT_OFFICE_CONFIG };
  const errors: string[] = [];
  for (const name of Object.keys(env)) {
    if (name.startsWith("AIO_OFFICE_") && !Object.hasOwn(CONFIG_ENV, name)) {
      errors.push(`${name}: unbekannte Einstellung`);
    }
  }
  const value = (name: string): string | undefined => env[name];
  const path = (
    name: string,
    key: "dbPath" | "passwordFile" | "constitutionPath" | "socketPath",
  ) => {
    const given = value(name);
    if (given === undefined) {
      return;
    }
    if (!isAbsolute(given)) {
      errors.push(`${name}: absoluter Pfad erwartet`);
      return;
    }
    config[key] = given;
  };
  const port = (name: string, key: "gatewayPort" | "apiPort") => {
    const given = value(name);
    if (given === undefined) {
      return;
    }
    // 0 heißt: freien Port wählen (für Tests).
    if (!/^\d{1,5}$/.test(given) || Number(given) > 65_535) {
      errors.push(`${name}: Port von 0 bis 65535 erwartet`);
      return;
    }
    config[key] = Number(given);
  };

  path("AIO_OFFICE_DB", "dbPath");
  path("AIO_OFFICE_PASSWORT_DATEI", "passwordFile");
  path("AIO_OFFICE_VERFASSUNG", "constitutionPath");
  path("AIO_SUPERVISOR_SOCKET", "socketPath");
  port("AIO_OFFICE_GATEWAY_PORT", "gatewayPort");
  port("AIO_OFFICE_API_PORT", "apiPort");

  const host = value("AIO_OFFICE_HOST");
  if (host !== undefined) {
    if (!HOST_PATTERN.test(host)) {
      errors.push("AIO_OFFICE_HOST: Hostname mit optionalem Port erwartet, nur Kleinbuchstaben");
    } else {
      config.webHost = host;
    }
  }
  const consoleUrl = value("AIO_OFFICE_KONSOLE");
  if (consoleUrl !== undefined) {
    if (consoleUrl === "") {
      config.consoleUrl = null;
    } else {
      try {
        config.consoleUrl = checkConsoleUrl(consoleUrl);
      } catch (error) {
        errors.push(`AIO_OFFICE_KONSOLE: ${(error as Error).message}`);
      }
    }
  }
  const level = value("AIO_OFFICE_LOG");
  if (level !== undefined) {
    if (isLogLevel(level)) {
      config.logLevel = level;
    } else {
      errors.push("AIO_OFFICE_LOG: debug, info, warn oder error erwartet");
    }
  }

  if (config.gatewayPort !== 0 && config.gatewayPort === config.apiPort) {
    errors.push("Gateway und Office-API brauchen verschiedene Ports");
  }
  if (errors.length > 0) {
    throw new ConfigError(`Einstellungen ungültig: ${errors.join("; ")}`);
  }
  return config;
}
