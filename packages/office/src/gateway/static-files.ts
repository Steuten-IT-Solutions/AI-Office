import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Auslieferung des Webinterface (P10). Vite baut den Browser-Code nach `packages/office/web/dist/`
 * (`pnpm --filter @ai-office/office build:web`, plan.md Kap. 3.4).
 *
 * Ausgeliefert werden nur `index.html` unter `/` und die Dateien in `dist/assets/` mit bekannter
 * Endung. Die Liste entsteht beim ersten Zugriff aus dem Verzeichnis; ein Pfad aus der Anfrage
 * wird nur in dieser Liste nachgeschlagen und nie mit dem Verzeichnis verbunden. Path Traversal
 * ist damit ausgeschlossen.
 */

export const DEFAULT_WEB_DIST = fileURLToPath(new URL("../../web/dist/", import.meta.url));

/** Inhaltstypen nach Endung. Andere Dateien liefert das Gateway nicht aus. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const HTML = "text/html; charset=utf-8";

/** Dateinamen, wie Vite sie in `assets/` schreibt. */
const ASSET_NAME = /^[A-Za-z0-9_-]+\.(js|css)$/;

/**
 * Content-Security-Policy des Office. Maßgeblich ist die des Reverse-Proxys (S13, Kap. 4.7), der
 * diese überschreibt. Sie gilt hier trotzdem, falls das Office einmal direkt erreichbar ist:
 * keine Inline-Skripte, keine Inline-Styles, keine fremden Quellen (Kap. 5.11).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

/** Header für jede Datei des Webinterface. */
export const WEB_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

/** Dateien unter `/assets/` tragen einen Hash im Namen und ändern sich nie. */
const IMMUTABLE = "public, max-age=31536000, immutable";

export interface WebFile {
  type: string;
  body: Buffer;
  /** `Cache-Control`; `index.html` wird nie zwischengespeichert. */
  cacheControl: string;
}

/** Die Dateien des gebauten Webinterface, im Speicher gehalten. */
export class StaticFiles {
  private readonly dir: string;
  private files: Map<string, WebFile> | null = null;

  constructor(dir: string = DEFAULT_WEB_DIST) {
    this.dir = dir;
  }

  /** Ob der Build vorhanden ist (`index.html` existiert). */
  get built(): boolean {
    return this.load().has("/");
  }

  /** URL-Pfade, die ausgeliefert werden. */
  paths(): string[] {
    return [...this.load().keys()];
  }

  /** `undefined`, wenn der Pfad nicht zum Webinterface gehört. */
  get(path: string): WebFile | undefined {
    return this.load().get(path);
  }

  private load(): Map<string, WebFile> {
    if (this.files !== null) {
      return this.files;
    }
    const files = new Map<string, WebFile>();
    const index = join(this.dir, "index.html");
    if (!isFile(index)) {
      // Ohne Build kein Zwischenspeichern: Ein späteres `build:web` soll ohne Neustart wirken.
      return files;
    }
    files.set("/", { type: HTML, body: readFileSync(index), cacheControl: "no-store" });
    const assets = join(this.dir, "assets");
    for (const name of isDirectory(assets) ? readdirSync(assets).sort() : []) {
      const match = ASSET_NAME.exec(name);
      const path = join(assets, name);
      if (match === null || !isFile(path)) {
        continue;
      }
      files.set(`/assets/${name}`, {
        type: CONTENT_TYPES[`.${match[1] as string}`] as string,
        body: readFileSync(path),
        cacheControl: IMMUTABLE,
      });
    }
    this.files = files;
    return files;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
