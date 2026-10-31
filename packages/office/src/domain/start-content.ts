import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_START_DIR } from "./start-data.ts";
import { Reader, isId, parsed, type Parsed, ValidationError } from "./validation.ts";

/**
 * Startinhalte (P11): Startbücher und Persona-Texte der Startagenten, siehe
 * `data/start/README.md`.
 *
 * Ein Buch ist eine Markdown-Datei mit Metadaten (plan.md Kap. 5.3). Die Metadaten stehen als
 * einfacher Kopf zwischen zwei Zeilen `---`, je Zeile `schlüssel: wert`. Mehr Syntax braucht es
 * nicht, deshalb kein YAML-Parser (E34).
 */

export const TRUST_LEVELS = ["intern", "extern-ungeprüft", "extern-geprüft"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export interface Book {
  /** Dateiname ohne `.md`. */
  id: string;
  title: string;
  source: string;
  /** ISO-Datum `JJJJ-MM-TT`. */
  date: string;
  /** Agenten-ID oder `ceo`. */
  owner: string;
  trust: TrustLevel;
  body: string;
}

export interface Persona {
  agentId: string;
  date: string;
  body: string;
}

/**
 * Grobe, absichtlich vorsichtige Schätzung der Tokens: 3 Zeichen je Token.
 * [Annahme] Ein Tokenizer für Claude-Modelle steht offline nicht zur Verfügung, und echte
 * Aufrufe sind in Tests verboten (E23). Für deutschen Text liegt der echte Wert vermutlich
 * darunter; das ist nicht gemessen.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Obergrenze für den Persona-Abschnitt im System-Prompt (plan.md Kap. 5.1). */
export const MAX_PERSONA_TOKENS = 300;

/**
 * Anteil des Startbuchs „Firmenhandbuch“ am generierten Handbuch. Das ganze Handbuch hat eine
 * harte Obergrenze von 2.000 Tokens (Kap. 5.2, [Annahme]); es enthält zusätzlich Verfassung,
 * Weisungen und Organigramm. [Annahme: 600]
 */
export const MAX_HANDBOOK_START_TOKENS = 600;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Trennt Kopf und Text. Wirft, wenn der Kopf fehlt oder eine Zeile nicht `schlüssel: wert` ist. */
export function splitFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end === -1) {
    throw new ValidationError("Kopf", [
      "Datei muss mit einem Kopf zwischen zwei Zeilen --- beginnen",
    ]);
  }
  const meta: Record<string, string> = {};
  const issues: string[] = [];
  lines.slice(1, end).forEach((line, index) => {
    const match = /^([a-z]+):\s*(.+)$/.exec(line);
    if (match === null) {
      issues.push(`Zeile ${String(index + 2)}: schlüssel: wert erwartet`);
      return;
    }
    const [, key, value] = match as unknown as [string, string, string];
    if (key in meta) {
      issues.push(`${key}: doppelt`);
    }
    meta[key] = value.trim();
  });
  if (issues.length > 0) {
    throw new ValidationError("Kopf", issues);
  }
  return {
    meta,
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

function checkDate(r: Reader, key: string): string {
  const value = r.string(key);
  if (value !== "" && !DATE_PATTERN.test(value)) {
    r.issues.push(`${key}: Datum JJJJ-MM-TT erwartet`);
  }
  return value;
}

export function parseBook(id: string, text: string): Parsed<Book> {
  const { meta, body } = splitFrontMatter(text);
  const r = new Reader(meta).only("titel", "quelle", "datum", "besitzer", "vertrauensstufe");
  const book: Book = {
    id,
    title: r.string("titel", { maxLength: 200 }),
    source: r.string("quelle"),
    date: checkDate(r, "datum"),
    owner: r.id("besitzer"),
    trust: r.oneOf("vertrauensstufe", TRUST_LEVELS),
    body,
  };
  if (!isId(id)) {
    r.issues.push("Dateiname ist keine gültige ID");
  }
  if (body === "") {
    r.issues.push("Text fehlt");
  }
  return parsed(r, book);
}

export function parsePersona(text: string): Parsed<Persona> {
  const { meta, body } = splitFrontMatter(text);
  const r = new Reader(meta).only("agent", "datum");
  const persona: Persona = { agentId: r.id("agent"), date: checkDate(r, "datum"), body };
  if (body === "") {
    r.issues.push("Text fehlt");
  }
  const tokens = estimateTokens(body);
  if (tokens > MAX_PERSONA_TOKENS) {
    r.issues.push(
      `Text hat geschätzt ${String(tokens)} Tokens, höchstens ${String(MAX_PERSONA_TOKENS)}`,
    );
  }
  return parsed(r, persona);
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

function orThrow<T>(subject: string, result: Parsed<T>): T {
  if (!result.ok) {
    throw new ValidationError(subject, result.issues);
  }
  return result.value;
}

/** Liest die Startbücher. Startbücher sind handgeschrieben und daher `intern` (Kap. 5.3). */
export function loadStartBooks(directory: string = join(DEFAULT_START_DIR, "books")): Book[] {
  return markdownFiles(directory).map((name) => {
    const book = orThrow(
      `books/${name}`,
      parseBook(name.slice(0, -3), readFileSync(join(directory, name), "utf8")),
    );
    if (book.trust !== "intern") {
      throw new ValidationError(`books/${name}`, ["Startbücher haben die Vertrauensstufe intern"]);
    }
    if (book.id === "firmenhandbuch" && estimateTokens(book.body) > MAX_HANDBOOK_START_TOKENS) {
      throw new ValidationError(`books/${name}`, [
        `Text hat geschätzt ${String(estimateTokens(book.body))} Tokens, höchstens ${String(MAX_HANDBOOK_START_TOKENS)}`,
      ]);
    }
    return book;
  });
}

/** Liest die Persona-Texte. Der Dateiname muss der Agenten-ID entsprechen. */
export function loadStartPersonas(
  directory: string = join(DEFAULT_START_DIR, "personas"),
): Persona[] {
  return markdownFiles(directory).map((name) => {
    const persona = orThrow(
      `personas/${name}`,
      parsePersona(readFileSync(join(directory, name), "utf8")),
    );
    if (`${persona.agentId}.md` !== name) {
      throw new ValidationError(`personas/${name}`, ["Dateiname muss der Agenten-ID entsprechen"]);
    }
    return persona;
  });
}
