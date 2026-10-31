/**
 * Kleine Prüfhilfen für Daten aus JSON-Dateien und Ereignis-Payloads.
 *
 * Bewusst ohne Schema-Bibliothek: Das Domänenmodell braucht nur wenige, flache Strukturen, und
 * jede neue Abhängigkeit vergrößert die Lieferkette (E34). Die Prüfungen im Office dienen nur dem
 * Komfort; sicherheitsrelevante Prüfungen liegen im Supervisor (E22).
 */

export class ValidationError extends Error {
  override name = "ValidationError";
  readonly issues: readonly string[];

  constructor(subject: string, issues: readonly string[]) {
    super(`${subject} ist ungültig: ${issues.join("; ")}`);
    this.issues = issues;
  }
}

type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** IDs: Kleinbuchstaben, Ziffern und Bindestriche, beginnt mit Buchstabe oder Ziffer. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/**
 * Liest Felder aus einem unbekannten Wert und sammelt alle Fehler, statt beim ersten
 * abzubrechen. So sieht man bei einer fehlerhaften Datendatei alle Probleme auf einmal.
 */
export class Reader {
  readonly issues: string[];
  private readonly record: UnknownRecord;
  private readonly path: string;

  constructor(value: unknown, path = "", issues: string[] = []) {
    this.issues = issues;
    this.path = path;
    if (isRecord(value)) {
      this.record = value;
    } else {
      this.record = {};
      this.issues.push(`${path || "Wert"}: Objekt erwartet`);
    }
  }

  private at(key: string): string {
    return this.path === "" ? key : `${this.path}.${key}`;
  }

  /** Meldet Felder, die das Schema nicht kennt. Tippfehler in Datendateien fallen so auf. */
  only(...keys: string[]): this {
    for (const key of Object.keys(this.record)) {
      if (!keys.includes(key)) {
        this.issues.push(`${this.at(key)}: unbekanntes Feld`);
      }
    }
    return this;
  }

  string(key: string, options: { maxLength?: number } = {}): string {
    const value = this.record[key];
    if (typeof value !== "string" || value.trim() === "") {
      this.issues.push(`${this.at(key)}: nicht leere Zeichenkette erwartet`);
      return "";
    }
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      this.issues.push(`${this.at(key)}: höchstens ${String(options.maxLength)} Zeichen`);
    }
    return value;
  }

  optionalString(key: string): string | null {
    const value = this.record[key];
    if (value === undefined || value === null) {
      return null;
    }
    return this.string(key);
  }

  id(key: string): string {
    const value = this.record[key];
    if (!isId(value)) {
      this.issues.push(`${this.at(key)}: ID erwartet (a-z, 0-9, Bindestrich)`);
      return "";
    }
    return value;
  }

  optionalId(key: string): string | null {
    const value = this.record[key];
    if (value === undefined || value === null) {
      return null;
    }
    return this.id(key);
  }

  integer(key: string, min: number, max: number): number {
    const value = this.record[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      this.issues.push(
        `${this.at(key)}: ganze Zahl von ${String(min)} bis ${String(max)} erwartet`,
      );
      return min;
    }
    return value;
  }

  oneOf<T extends string>(key: string, allowed: readonly T[]): T {
    const value = this.record[key];
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      this.issues.push(`${this.at(key)}: einer von ${allowed.join(", ")} erwartet`);
      return allowed[0] as T;
    }
    return value as T;
  }

  /** Liste ohne Doppelungen aus erlaubten Werten. */
  setOf<T extends string>(key: string, allowed: readonly T[]): T[] {
    const items = this.list(key);
    const result: T[] = [];
    items.forEach((item, index) => {
      if (typeof item !== "string" || !(allowed as readonly string[]).includes(item)) {
        this.issues.push(
          `${this.at(key)}[${String(index)}]: einer von ${allowed.join(", ")} erwartet`,
        );
      } else if (result.includes(item as T)) {
        this.issues.push(`${this.at(key)}[${String(index)}]: doppelt`);
      } else {
        result.push(item as T);
      }
    });
    return result;
  }

  strings(key: string, options: { min?: number } = {}): string[] {
    const items = this.list(key);
    if (items.length < (options.min ?? 0)) {
      this.issues.push(`${this.at(key)}: mindestens ${String(options.min)} Einträge erwartet`);
    }
    return items.map((item, index) => {
      if (typeof item !== "string" || item.trim() === "") {
        this.issues.push(`${this.at(key)}[${String(index)}]: nicht leere Zeichenkette erwartet`);
        return "";
      }
      return item;
    });
  }

  /** Rohwert eines Felds, für eigene Prüfungen. */
  raw(key: string): unknown {
    return this.record[key];
  }

  object(key: string): Reader {
    return new Reader(this.record[key], this.at(key), this.issues);
  }

  objects(key: string): Reader[] {
    return this.list(key).map(
      (item, index) => new Reader(item, `${this.at(key)}[${String(index)}]`, this.issues),
    );
  }

  private list(key: string): unknown[] {
    const value = this.record[key];
    if (!Array.isArray(value)) {
      this.issues.push(`${this.at(key)}: Liste erwartet`);
      return [];
    }
    return value as unknown[];
  }
}

/** Ergebnis einer Prüfung: Wert oder Fehlerliste. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export function parsed<T>(reader: Reader, value: T): Parsed<T> {
  return reader.issues.length === 0 ? { ok: true, value } : { ok: false, issues: reader.issues };
}
