import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Wurde diese Datei direkt mit `node <datei>` gestartet (und nicht importiert)? */
export function isMain(metaUrl: string): boolean {
  const script = process.argv[1];
  if (script === undefined) {
    return false;
  }
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/** Wert hinter einem Flag, z. B. `--modell haiku`. */
export function option(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Umgebungsvariable ${name} fehlt`);
  }
  return value;
}
