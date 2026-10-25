/**
 * Kanonisches JSON für die Hash-Kette: Schlüssel sortiert, keine Leerzeichen, nur JSON-Werte.
 * Dieselben Daten ergeben immer dieselbe Zeichenkette, unabhängig von der Einfügereihenfolge.
 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Nicht endliche Zahl ist kein JSON-Wert");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Nur einfache Objekte sind erlaubt");
      }
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`Typ ${typeof value} ist kein JSON-Wert`);
  }
}
