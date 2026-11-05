/**
 * Protokoll des Proxys (proxy/aio_proxy.py) auswerten und die Allowlist für S1b bauen.
 * `normalizePath` muss genau wie `normalize_path` im Addon arbeiten; der Test prüft Beispiele.
 */
import { isObject } from "./stream.ts";

export type Auth = "unser" | "fremd" | "keins";

export interface LogEntry {
  modus: string;
  methode: string;
  host: string;
  pfad: string;
  auth: Auth;
  entscheidung: string;
}

export interface AllowEntry {
  methode: string;
  host: string;
  pfad: string;
  /** Erlaubte Anmeldung. `fremd` kommt nie hinein. */
  auth: Auth[];
  /** Wie oft im ersten Durchgang gesehen. */
  anzahl: number;
}

const ID_SEGMENT = /^(?:[0-9a-fA-F-]{16,}|[0-9]+|[A-Za-z0-9_-]{24,})$/;

export function normalizePath(path: string): string {
  const withoutQuery = path.split("?", 1)[0] ?? "";
  return withoutQuery
    .split("/")
    .map((part) => (ID_SEGMENT.test(part) ? "*" : part))
    .join("/");
}

function isAuth(value: unknown): value is Auth {
  return value === "unser" || value === "fremd" || value === "keins";
}

export function parseLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      isObject(raw) &&
      typeof raw["methode"] === "string" &&
      typeof raw["host"] === "string" &&
      typeof raw["pfad"] === "string" &&
      isAuth(raw["auth"])
    ) {
      entries.push({
        modus: typeof raw["modus"] === "string" ? raw["modus"] : "?",
        methode: raw["methode"],
        host: raw["host"],
        pfad: raw["pfad"],
        auth: raw["auth"],
        entscheidung: typeof raw["entscheidung"] === "string" ? raw["entscheidung"] : "?",
      });
    }
  }
  return entries;
}

function key(e: { methode: string; host: string; pfad: string }): string {
  return `${e.methode} ${e.host}${e.pfad}`;
}

/**
 * Allowlist aus den Anfragen des ersten Durchgangs. Anfragen mit fremder Anmeldung kommen nie
 * hinein; ein Endpunkt, der mit unserem Token gesehen wurde, verlangt es auch im zweiten
 * Durchgang. Ohne Anmeldung gesehen, bleibt er ohne Anmeldung erlaubt (fremde Schlüssel nie).
 */
export function buildAllowlist(entries: LogEntry[]): AllowEntry[] {
  const map = new Map<string, AllowEntry>();
  for (const e of entries) {
    if (e.auth === "fremd" || e.methode === "CONNECT") {
      continue;
    }
    const k = key(e);
    const existing = map.get(k);
    if (existing === undefined) {
      map.set(k, { methode: e.methode, host: e.host, pfad: e.pfad, auth: [e.auth], anzahl: 1 });
    } else {
      existing.anzahl++;
      if (!existing.auth.includes(e.auth)) {
        existing.auth.push(e.auth);
      }
    }
  }
  for (const entry of map.values()) {
    // Mit unserem Token gesehen: Dann darf derselbe Endpunkt nicht ohne Anmeldung durch.
    if (entry.auth.includes("unser")) {
      entry.auth = ["unser"];
    }
  }
  return [...map.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

/** Zählt Anfragen je Endpunkt und Entscheidung (für die Tabellen im Bericht). */
export function countByEndpoint(entries: LogEntry[]): string[][] {
  const counts = new Map<string, { entry: LogEntry; n: number }>();
  for (const e of entries) {
    const k = `${key(e)} ${e.auth} ${e.entscheidung}`;
    const current = counts.get(k);
    if (current === undefined) {
      counts.set(k, { entry: e, n: 1 });
    } else {
      current.n++;
    }
  }
  return [...counts.values()]
    .sort((a, b) => key(a.entry).localeCompare(key(b.entry)))
    .map(({ entry, n }) => [
      entry.methode,
      entry.host,
      entry.pfad,
      entry.auth,
      entry.entscheidung,
      String(n),
    ]);
}
