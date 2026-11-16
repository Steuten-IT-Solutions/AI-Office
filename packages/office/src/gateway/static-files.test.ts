import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTENT_SECURITY_POLICY,
  DEFAULT_WEB_DIR,
  StaticFiles,
  WEB_FILES,
} from "./static-files.ts";

const served = new Set(Object.keys(WEB_FILES));
const html = readFileSync(join(DEFAULT_WEB_DIR, "index.html"), "utf8");

describe("Dateien des Webinterface (P10)", () => {
  it("jede gelistete Datei existiert", () => {
    const files = new StaticFiles();
    for (const path of served) {
      expect([path, files.get(path)?.body.length ?? 0]).not.toEqual([path, 0]);
    }
  });

  it("jedes Modul im Web-Verzeichnis wird ausgeliefert, jeder Import zeigt auf ein ausgeliefertes", () => {
    const modules = readdirSync(DEFAULT_WEB_DIR).filter((name) => name.endsWith(".js"));
    expect(modules.length).toBeGreaterThan(0);
    for (const name of modules) {
      expect(served).toContain(`/${name}`);
      const source = readFileSync(join(DEFAULT_WEB_DIR, name), "utf8");
      for (const match of source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)) {
        const target = match[1] as string;
        expect([name, target]).toEqual([name, expect.stringMatching(/^\.\/[a-z-]+\.js$/)]);
        expect(served).toContain(target.slice(1));
      }
      // Keine dynamischen Importe (Typimporte in JSDoc `{import(…)}` zählen nicht) und keine
      // Module von fremden Servern.
      expect(source).not.toMatch(/(?<!\{)\bimport\s*\(/);
      expect(source).not.toMatch(/from\s+"(https?:)?\/\//);
    }
  });

  it("index.html ohne Inline-Skript, Inline-Style und Ereignis-Attribute (CSP)", () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBe(1);
    for (const [tag, body] of scripts) {
      expect(tag).toMatch(/\ssrc="\/app\.js"/);
      expect(body?.trim()).toBe("");
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    for (const [, url] of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      expect(served).toContain(url);
    }
  });

  it("die CSP erlaubt keine Inline-Skripte und keine fremden Quellen", () => {
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-|\*|https?:/);
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
  });

  it("liefert nur gelistete Pfade, auch bei Tricks mit Pfaden", () => {
    const files = new StaticFiles();
    for (const path of [
      "/../package.json",
      "/index.html/../../package.json",
      "/test/views.test.ts",
      "/tsconfig.json",
      "/app.js?x",
      "/APP.JS",
      "/constructor",
      "/__proto__",
      "/hasOwnProperty",
    ]) {
      expect([path, files.get(path)]).toEqual([path, undefined]);
    }
  });
});
