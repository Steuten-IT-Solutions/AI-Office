import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Build des Webinterface (P10, plan.md Kap. 3.4: Vite). Ausgabe nach `web/dist/`, die das Gateway
 * mit fester Dateiliste ausliefert (`src/gateway/static-files.ts`).
 *
 * Die Einstellungen halten die Ausgabe CSP-tauglich (Kap. 4.7, 5.11): keine Inline-Skripte, keine
 * als `data:` eingebetteten Dateien, kein Polyfill für `modulepreload` (der Firefox aus E49 kann
 * das nativ). Den Entwicklungsserver von Vite nutzt das Projekt nicht: Er fügt Inline-Skripte ein
 * und kennt Anmeldung und CSRF des Gateways nicht.
 */
export const WEB_ROOT = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: WEB_ROOT,
  base: "/",
  publicDir: false,
  logLevel: "warn",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    // Kein Hinweis auf fehlende Lizenzen o. Ä. im Bundle; nur unser Code und keine Abhängigkeiten.
    reportCompressedSize: false,
  },
});
