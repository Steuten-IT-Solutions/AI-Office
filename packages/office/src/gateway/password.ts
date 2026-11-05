import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Passwort des CEO für das Webinterface (P09, plan.md Kap. 3.4 „VPN + Login“, Kap. 4.7).
 *
 * Gespeichert wird nur ein scrypt-Hash, Format `scrypt$N$r$p$Salz$Hash` (Base64url). Parameter
 * nach der OWASP-Empfehlung N = 2^17, r = 8, p = 1
 * (https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
 *
 * Das Webinterface kann nichts freigeben (E26); die Konsole des Supervisors hat einen eigenen
 * Zugang mit zweitem Faktor. Das Office kann sich selbst verändern und ist keine Vertrauensbasis
 * (E22). Das Passwort schützt die Ansicht und den Chat vor anderen Geräten im VPN.
 */

export const MIN_PASSWORD_LENGTH = 12;
/** Längstes Passwort; begrenzt die Arbeit je Anmeldeversuch. */
export const MAX_PASSWORD_LENGTH = 1024;

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT: Readonly<ScryptParams> = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    // Speicherbedarf 128 · N · r Bytes, bei den Standardwerten 128 MiB; Nodes Vorgabe sind 32 MiB.
    maxmem: 256 * params.N * params.r,
  };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFC"), salt, KEY_LENGTH, options, (error, key) => {
      if (error === null) {
        resolve(key);
      } else {
        reject(error);
      }
    });
  });
}

/**
 * Länge in Unicode-Codepunkten. NIST SP 800-63B-4 Abschnitt 3.1.1.2 zählt jeden Codepunkt als ein Zeichen
 * (https://pages.nist.gov/800-63-4/sp800-63b.html#passwordver).
 */
function codePoints(text: string): number {
  return Array.from(text).length;
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<string> {
  if (codePoints(password) < MIN_PASSWORD_LENGTH) {
    throw new Error(`Das Passwort braucht mindestens ${String(MIN_PASSWORD_LENGTH)} Zeichen`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Das Passwort hat höchstens ${String(MAX_PASSWORD_LENGTH)} Zeichen`);
  }
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, params);
  return [
    "scrypt",
    String(params.N),
    String(params.r),
    String(params.p),
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const match = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(
    stored.trim(),
  );
  if (match === null) {
    return null;
  }
  const params = { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  // Nur sinnvolle Werte: N eine Zweierpotenz, kein Hash, der den Rechner lahmlegt.
  const powerOfTwo = params.N > 1 && (params.N & (params.N - 1)) === 0;
  if (!powerOfTwo || params.N > 2 ** 20 || params.r < 1 || params.r > 32) {
    return null;
  }
  if (params.p < 1 || params.p > 16) {
    return null;
  }
  const salt = Buffer.from(match[4] as string, "base64url");
  const key = Buffer.from(match[5] as string, "base64url");
  if (salt.length < SALT_LENGTH || key.length !== KEY_LENGTH) {
    return null;
  }
  return { params, salt, key };
}

/** Prüft ein Passwort gegen einen gespeicherten Hash, in konstanter Zeit für den Vergleich. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (parsed === null || password.length > MAX_PASSWORD_LENGTH) {
    return false;
  }
  const key = await derive(password, parsed.salt, parsed.params);
  return timingSafeEqual(key, parsed.key);
}

/** Ob die Zeichenkette ein gültiger gespeicherter Hash ist. */
export function isPasswordHash(stored: string): boolean {
  return parseHash(stored) !== null;
}

/**
 * Liest den Hash aus der Datei. `null`, wenn sie fehlt; dann ist keine Anmeldung möglich. Bei
 * jedem Versuch neu gelesen: Ein neues Passwort gilt ohne Neustart.
 */
export function readPasswordFile(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const stored = text.trim();
  return isPasswordHash(stored) ? stored : null;
}

/** Schreibt den Hash atomar mit Modus 0600 (erst eine Temporärdatei, dann umbenennen). */
export function writePasswordFile(path: string, stored: string): void {
  if (!isPasswordHash(stored)) {
    throw new Error("Kein gültiger Passwort-Hash");
  }
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}`);
  writeFileSync(tmp, `${stored}\n`, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}
