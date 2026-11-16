import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Auslieferung des Webinterface (P10). Der Browser-Code liegt als ES-Module ohne Build-Schritt in
 * `packages/office/web/`. Damit läuft im Browser genau der Code, der im PR geprüft wurde.
 *
 * Ausgeliefert wird nur, was hier steht. Pfade aus der Anfrage werden nie mit dem Verzeichnis
 * verbunden, Path Traversal ist damit ausgeschlossen.
 */

export const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));

const HTML = "text/html; charset=utf-8";
const JS = "text/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";

/** URL-Pfad → Datei im Web-Verzeichnis und Inhaltstyp. */
export const WEB_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: "index.html", type: HTML },
  "/style.css": { file: "style.css", type: CSS },
  "/app.js": { file: "app.js", type: JS },
  "/api.js": { file: "api.js", type: JS },
  "/dom.js": { file: "dom.js", type: JS },
  "/format.js": { file: "format.js", type: JS },
  "/views.js": { file: "views.js", type: JS },
};

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

export interface WebFile {
  type: string;
  body: Buffer;
}

/** Liest die Dateien beim ersten Zugriff und hält sie danach im Speicher. */
export class StaticFiles {
  private readonly dir: string;
  private readonly cache = new Map<string, WebFile>();

  constructor(dir: string = DEFAULT_WEB_DIR) {
    this.dir = dir.endsWith("/") ? dir : `${dir}/`;
  }

  /** `undefined`, wenn der Pfad nicht zum Webinterface gehört. */
  get(path: string): WebFile | undefined {
    const entry = Object.hasOwn(WEB_FILES, path) ? WEB_FILES[path] : undefined;
    if (entry === undefined) {
      return undefined;
    }
    let file = this.cache.get(path);
    if (file === undefined) {
      file = { type: entry.type, body: readFileSync(this.dir + entry.file) };
      this.cache.set(path, file);
    }
    return file;
  }
}
