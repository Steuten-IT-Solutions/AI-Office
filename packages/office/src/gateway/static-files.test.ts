import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY, StaticFiles } from "./static-files.ts";

const WEB = fileURLToPath(new URL("../../web/", import.meta.url));

/** Prüfungen für eine HTML-Datei ohne Inline-Code (CSP, Kap. 5.11). */
function expectNoInlineCode(html: string): void {
  for (const [tag, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    expect(tag).toMatch(/\stype="module"/);
    expect(tag).toMatch(/\ssrc="\/[^"]+"/);
    expect(body?.trim()).toBe("");
  }
  expect(html).not.toMatch(/<style\b/i);
  expect(html).not.toMatch(/\sstyle\s*=/i);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).not.toMatch(/javascript:/i);
  expect(html).not.toMatch(/(src|href)="(https?:)?\/\//i);
}

describe("Quelle des Webinterface (P10)", () => {
  it("index.html ohne Inline-Skript, Inline-Style und Ereignis-Attribute", () => {
    const html = readFileSync(join(WEB, "index.html"), "utf8");
    expectNoInlineCode(html);
    expect([...html.matchAll(/<script\b/gi)]).toHaveLength(1);
  });

  it("die CSP erlaubt keine Inline-Skripte und keine fremden Quellen", () => {
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-|\*|https?:/);
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
  });
});

describe("Build mit Vite (P10)", () => {
  let out: string;
  let files: StaticFiles;

  beforeAll(async () => {
    // Baut wie `pnpm --filter @ai-office/office build:web`, aber in ein Temp-Verzeichnis. So prüft
    // die CI den Build, ohne dass der Workflow geändert werden muss.
    out = mkdtempSync(join(tmpdir(), "aio-web-"));
    await build({
      configFile: join(WEB, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir: out, emptyOutDir: true },
    });
    files = new StaticFiles(out);
  }, 60_000);

  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it("liefert index.html und die Assets aus, sonst nichts", () => {
    expect(files.built).toBe(true);
    const paths = files.paths();
    expect(paths[0]).toBe("/");
    expect(paths.slice(1).every((p) => /^\/assets\/[A-Za-z0-9_-]+\.(js|css)$/.test(p))).toBe(true);
    expect(paths.filter((p) => p.endsWith(".js"))).toHaveLength(1);
    expect(paths.filter((p) => p.endsWith(".css"))).toHaveLength(1);
    expect(files.get("/")?.cacheControl).toBe("no-store");
    expect(files.get(paths[1] as string)?.cacheControl).toContain("immutable");
  });

  it("die gebaute Seite ist CSP-tauglich und verweist nur auf ausgelieferte Dateien", () => {
    const html = (files.get("/") as { body: Buffer }).body.toString("utf8");
    expectNoInlineCode(html);
    const refs = [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
    expect(refs.length).toBe(2);
    for (const ref of refs) {
      expect(files.paths()).toContain(ref);
    }
  });

  it("das Bundle enthält keinen Weg zu HTML aus Zeichenketten und keine fremden Module", () => {
    for (const path of files.paths().filter((p) => p.endsWith(".js"))) {
      const code = (files.get(path) as { body: Buffer }).body.toString("utf8");
      for (const forbidden of [
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "DOMParser",
        "eval(",
        "Function(",
      ]) {
        expect([path, forbidden, code.includes(forbidden)]).toEqual([path, forbidden, false]);
      }
      expect(code).not.toMatch(/\bimport\s*\(/);
      expect(code).not.toMatch(/from\s*["'](https?:)?\/\//);
    }
  });
});

describe("Auslieferung", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "aio-dist-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ohne Build nichts, auch kein Zwischenspeichern der leeren Liste", () => {
    const files = new StaticFiles(dir);
    expect(files.built).toBe(false);
    expect(files.get("/")).toBeUndefined();
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    expect(files.built).toBe(true);
  });

  it("nur index.html und Assets mit bekannter Endung, auch bei Tricks mit Pfaden", () => {
    mkdirSync(join(dir, "assets", "unter"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    writeFileSync(join(dir, "assets", "app-1.js"), "1");
    writeFileSync(join(dir, "assets", "app-1.js.map"), "{}");
    writeFileSync(join(dir, "assets", "bild.svg"), "<svg/>");
    writeFileSync(join(dir, "assets", "unter", "x.js"), "2");
    writeFileSync(join(dir, "geheim.js"), "3");
    const files = new StaticFiles(dir);
    expect(files.paths()).toEqual(["/", "/assets/app-1.js"]);
    expect(files.get("/assets/app-1.js")?.type).toBe("text/javascript; charset=utf-8");
    for (const path of [
      "/index.html",
      "/geheim.js",
      "/assets/app-1.js.map",
      "/assets/bild.svg",
      "/assets/unter/x.js",
      "/assets/../geheim.js",
      "/../package.json",
      "/assets/APP-1.JS",
      "/constructor",
      "/__proto__",
    ]) {
      expect([path, files.get(path)]).toEqual([path, undefined]);
    }
    expect(readdirSync(dir)).toContain("geheim.js");
  });
});
