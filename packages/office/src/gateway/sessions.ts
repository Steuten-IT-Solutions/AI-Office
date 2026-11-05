import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Sitzungen des CEO im Webinterface (P09, plan.md Kap. 4.7, 5.11).
 *
 * - Die Sitzungs-ID ist ein zufälliger Wert mit 256 Bit, nur im Cookie `__Host-aio-office`
 *   (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, ohne `Domain`). Das Office kennt nur
 *   ihren SHA-256-Wert; ein Vergleich über die Map verrät so nichts über die ID.
 * - Jede Sitzung hat ein eigenes CSRF-Token (256 Bit). Zustandsändernde Anfragen schicken es im
 *   Header `X-CSRF-Token`.
 * - Sitzungen liegen nur im Speicher. Nach einem Neustart des Office meldet sich der CEO neu an;
 *   auf der Platte liegt dadurch nichts, womit sich eine Sitzung übernehmen ließe.
 */

export const SESSION_COOKIE = "__Host-aio-office";

export interface SessionConfig {
  /** Ohne Anfrage so lange gültig. [Annahme: 8 h] */
  idleMs: number;
  /** Höchstens so lange nach der Anmeldung gültig. [Annahme: 24 h] */
  maxAgeMs: number;
  /** Höchstzahl gleichzeitiger Sitzungen; die älteste fällt weg. [Annahme: 10] */
  maxSessions: number;
}

export const DEFAULT_SESSION_CONFIG: Readonly<SessionConfig> = Object.freeze({
  idleMs: 8 * 3_600_000,
  maxAgeMs: 24 * 3_600_000,
  maxSessions: 10,
});

export interface Session {
  /** SHA-256 der Sitzungs-ID, Base64url. Taugt als Name in Logs, nicht als Cookie. */
  readonly handle: string;
  readonly csrfToken: string;
  readonly createdAt: number;
  lastSeenAt: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Vergleicht zwei Zeichenketten in konstanter Zeit (bei gleicher Länge). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export class Sessions {
  private readonly config: SessionConfig;
  private readonly now: () => number;
  private readonly byHandle = new Map<string, Session>();
  private readonly endHandlers: ((session: Session) => void)[] = [];

  constructor(config: Partial<SessionConfig> = {}, now: () => number = Date.now) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };
    this.now = now;
  }

  /** Neue Sitzung. Gibt die ID für das Cookie zurück; das Office behält nur ihren Hash. */
  create(): { id: string; session: Session } {
    this.prune();
    while (this.byHandle.size >= this.config.maxSessions) {
      const oldest = [...this.byHandle.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest === undefined) {
        break;
      }
      this.end(oldest);
    }
    const id = randomBytes(32).toString("base64url");
    const at = this.now();
    const session: Session = {
      handle: digest(id),
      csrfToken: randomBytes(32).toString("base64url"),
      createdAt: at,
      lastSeenAt: at,
    };
    this.byHandle.set(session.handle, session);
    return { id, session };
  }

  /** Sitzung zur ID aus dem Cookie, falls gültig. `touch` verlängert die Leerlaufzeit. */
  find(id: string | undefined, touch = true): Session | undefined {
    if (id === undefined || !/^[A-Za-z0-9_-]{43}$/.test(id)) {
      return undefined;
    }
    const session = this.byHandle.get(digest(id));
    if (session === undefined) {
      return undefined;
    }
    if (!this.valid(session)) {
      this.end(session);
      return undefined;
    }
    if (touch) {
      session.lastSeenAt = this.now();
    }
    return session;
  }

  /** Ob die Sitzung noch besteht und nicht abgelaufen ist. */
  isActive(session: Session): boolean {
    return this.byHandle.get(session.handle) === session && this.valid(session);
  }

  end(session: Session): void {
    if (this.byHandle.get(session.handle) !== session) {
      return;
    }
    this.byHandle.delete(session.handle);
    for (const handler of this.endHandlers) {
      handler(session);
    }
  }

  /** Beendet alle Sitzungen, z. B. nach einem neuen Passwort. */
  endAll(): void {
    for (const session of [...this.byHandle.values()]) {
      this.end(session);
    }
  }

  /** Wird für jede beendete oder abgelaufene Sitzung aufgerufen. */
  onEnd(handler: (session: Session) => void): void {
    this.endHandlers.push(handler);
  }

  /** Entfernt abgelaufene Sitzungen. */
  prune(): void {
    for (const session of [...this.byHandle.values()]) {
      if (!this.valid(session)) {
        this.end(session);
      }
    }
  }

  get size(): number {
    return this.byHandle.size;
  }

  /** Höchstdauer einer Sitzung; so lange gilt auch das Cookie. */
  get maxAgeMs(): number {
    return this.config.maxAgeMs;
  }

  private valid(session: Session): boolean {
    const at = this.now();
    return (
      at - session.lastSeenAt < this.config.idleMs && at - session.createdAt < this.config.maxAgeMs
    );
  }
}

/** `Set-Cookie` für eine neue Sitzung. `Max-Age` folgt der Höchstdauer. */
export function sessionCookie(id: string, maxAgeMs: number): string {
  return [
    `${SESSION_COOKIE}=${id}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${String(Math.floor(maxAgeMs / 1000))}`,
  ].join("; ");
}

/** `Set-Cookie`, das das Sitzungscookie im Browser löscht. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * Wert des Sitzungscookies aus dem Header `Cookie`. Kommt der Name mehrfach vor, gilt keiner:
 * Ein zweites Cookie mit demselben Namen wäre ein Versuch, die Sitzung unterzuschieben.
 */
export function sessionIdFromCookie(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`))
    .map((part) => part.slice(SESSION_COOKIE.length + 1));
  return values.length === 1 ? values[0] : undefined;
}
