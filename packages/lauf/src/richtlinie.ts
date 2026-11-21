import { readFileSync } from "node:fs";
import { KonfigFehler } from "./konfig.ts";

/**
 * Prüfung der Managed Settings vor dem Start des CLI (plan.md Kap. 5.7, E50).
 *
 * Die Datei liegt nicht im Image. Der Container-Manager (S05) bindet `/etc/claude-code` aus dem
 * Supervisor schreibgeschützt ein. Fehlt die Einbindung oder ist die Datei für den Nutzer `agent`
 * nicht lesbar, liefe das CLI ohne Richtlinie: Laut Doku startet es dann „without that source's
 * policies“ und meldet das bei `-p` nur auf stderr
 * (https://code.claude.com/docs/en/managed-settings). Deshalb startet der Startprozess in diesem
 * Fall gar nichts.
 *
 * Geprüft wird nur, dass die Datei lesbar ist und ein nicht leeres JSON-Objekt enthält. Was darin
 * steht, legt allein der Supervisor fest.
 */

/** Ort der Managed Settings unter Linux laut Doku. */
export const MANAGED_SETTINGS = "/etc/claude-code/managed-settings.json";

export function pruefeManagedSettings(pfad: string = MANAGED_SETTINGS): void {
  let text: string;
  try {
    text = readFileSync(pfad, "utf8");
  } catch (fehler) {
    const code = (fehler as NodeJS.ErrnoException).code ?? "unbekannt";
    throw new KonfigFehler(`Managed Settings ${pfad} nicht lesbar (${code})`);
  }
  let wert: unknown;
  try {
    wert = JSON.parse(text);
  } catch {
    throw new KonfigFehler(`Managed Settings ${pfad} sind kein gültiges JSON`);
  }
  if (typeof wert !== "object" || wert === null || Array.isArray(wert)) {
    throw new KonfigFehler(`Managed Settings ${pfad} sind kein JSON-Objekt`);
  }
  if (Object.keys(wert).length === 0) {
    throw new KonfigFehler(`Managed Settings ${pfad} sind leer`);
  }
}
