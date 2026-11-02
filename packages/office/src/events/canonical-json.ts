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
        // Keine Lücken: `map` überspränge sie, und `[,]` wäre kein JSON.
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!(index in value)) {
            throw new TypeError("Arrays mit Lücken sind kein JSON-Wert");
          }
          items.push(canonicalJson(value[index]));
        }
        return `[${items.join(",")}]`;
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
