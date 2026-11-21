import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { KonfigFehler } from "./konfig.ts";
import { pruefeManagedSettings } from "./richtlinie.ts";

let datei: string;

beforeEach(() => {
  datei = join(mkdtempSync(join(tmpdir(), "aio-lauf-richtlinie-")), "managed-settings.json");
});

function mit(inhalt: string): () => void {
  writeFileSync(datei, inhalt);
  return () => {
    pruefeManagedSettings(datei);
  };
}

describe("pruefeManagedSettings", () => {
  it("akzeptiert ein nicht leeres JSON-Objekt", () => {
    expect(mit('{"disableAllHooks":true}')).not.toThrow();
  });

  it("lehnt eine fehlende Datei ab", () => {
    expect(() => {
      pruefeManagedSettings(join(datei, "..", "fehlt.json"));
    }).toThrow(/nicht lesbar \(ENOENT\)/);
  });

  it("lehnt ungültiges JSON ab", () => {
    expect(mit("{")).toThrow(/kein gültiges JSON/);
  });

  it("lehnt JSON ab, das kein Objekt ist", () => {
    expect(mit("[]")).toThrow(/kein JSON-Objekt/);
    expect(mit("null")).toThrow(/kein JSON-Objekt/);
  });

  it("lehnt ein leeres Objekt ab", () => {
    expect(mit("{}")).toThrow(/leer/);
  });

  // root liest die Datei trotz fehlender Rechte; der Fall lässt sich dann nicht nachstellen.
  it.skipIf(process.getuid?.() === 0)("lehnt eine nicht lesbare Datei ab", () => {
    writeFileSync(datei, '{"disableAllHooks":true}');
    chmodSync(datei, 0o000);
    expect(() => {
      pruefeManagedSettings(datei);
    }).toThrow(KonfigFehler);
  });
});
