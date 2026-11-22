import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_OFFICE_CONFIG, configFromEnv } from "./config.ts";

describe("configFromEnv", () => {
  it("nimmt ohne Variablen die Werte aus host/provision.sh", () => {
    expect(configFromEnv({ PATH: "/usr/bin", AIO_SONSTWAS: "x" })).toEqual(DEFAULT_OFFICE_CONFIG);
    expect(DEFAULT_OFFICE_CONFIG).toMatchObject({
      dbPath: "/var/lib/aio-office/office.db",
      socketPath: "/run/aio/supervisor.sock",
      webHost: "office.aio.internal:8444",
      gatewayPort: 8080,
    });
  });

  it("übernimmt gültige Werte aus der Umgebung", () => {
    expect(
      configFromEnv({
        AIO_OFFICE_DB: "/tmp/x/office.db",
        AIO_OFFICE_PASSWORT_DATEI: "/tmp/x/pw",
        AIO_OFFICE_VERFASSUNG: "/tmp/x/verfassung.md",
        AIO_SUPERVISOR_SOCKET: "/tmp/x/sup.sock",
        AIO_OFFICE_HOST: "office.test:8444",
        AIO_OFFICE_GATEWAY_PORT: "0",
        AIO_OFFICE_API_PORT: "0",
        AIO_OFFICE_KONSOLE: "",
        AIO_OFFICE_LOG: "debug",
      }),
    ).toEqual({
      dbPath: "/tmp/x/office.db",
      passwordFile: "/tmp/x/pw",
      constitutionPath: "/tmp/x/verfassung.md",
      socketPath: "/tmp/x/sup.sock",
      webHost: "office.test:8444",
      gatewayPort: 0,
      apiPort: 0,
      consoleUrl: null,
      logLevel: "debug",
    });
    expect(configFromEnv({ AIO_OFFICE_KONSOLE: "https://konsole.test" }).consoleUrl).toBe(
      "https://konsole.test/",
    );
  });

  it("meldet alle Fehler auf einmal, auch unbekannte Variablen", () => {
    const run = () =>
      configFromEnv({
        AIO_OFFICE_DB: "office.db",
        AIO_OFFICE_GATEWAY_PORT: "70000",
        AIO_OFFICE_API_PORT: "-1",
        AIO_OFFICE_HOST: "Office.Test",
        AIO_OFFICE_KONSOLE: "http://konsole.test",
        AIO_OFFICE_LOG: "laut",
        AIO_OFFICE_PORT: "8080",
      });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(
      "Einstellungen ungültig: AIO_OFFICE_PORT: unbekannte Einstellung; " +
        "AIO_OFFICE_DB: absoluter Pfad erwartet; " +
        "AIO_OFFICE_GATEWAY_PORT: Port von 0 bis 65535 erwartet; " +
        "AIO_OFFICE_API_PORT: Port von 0 bis 65535 erwartet; " +
        "AIO_OFFICE_HOST: Hostname mit optionalem Port erwartet, nur Kleinbuchstaben; " +
        "AIO_OFFICE_KONSOLE: consoleUrl: nur https ohne Zugangsdaten; " +
        "AIO_OFFICE_LOG: debug, info, warn oder error erwartet",
    );
  });

  it("verlangt verschiedene Ports für Gateway und Office-API", () => {
    expect(() =>
      configFromEnv({ AIO_OFFICE_GATEWAY_PORT: "3000", AIO_OFFICE_API_PORT: "3000" }),
    ).toThrow("Gateway und Office-API brauchen verschiedene Ports");
  });
});
