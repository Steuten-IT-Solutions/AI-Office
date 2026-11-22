import type { Readable, Writable } from "node:stream";
import {
  DEFAULT_SCRYPT,
  hashPassword,
  writePasswordFile,
  type ScryptParams,
} from "./gateway/password.ts";

/**
 * Befehl `main.ts passwort`: setzt das Passwort des CEO für das Webinterface (P09). Aufruf als
 * Nutzer des Office, damit die Datei ihm gehört:
 *
 *     sudo -u aio-office node /opt/aio-office/current/packages/office/src/main.ts passwort
 *
 * Am Terminal fragt der Befehl zweimal ohne Echo. Ohne Terminal liest er die erste Zeile von
 * stdin, etwa für ein Skript. Das Passwort steht nie in den Argumenten, denn die sind für alle
 * Nutzer des Rechners in `/proc` lesbar. Ein laufendes Office liest die Datei bei jeder
 * Anmeldung neu; ein Neustart ist nicht nötig.
 */

export interface PasswordInput extends Readable {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export interface PasswordCommandOptions {
  path: string;
  input: PasswordInput;
  /** Für Eingabeaufforderungen und Meldungen. */
  output: Writable;
  /** Nur für Tests kleiner. */
  scrypt?: ScryptParams;
}

export class PasswordAborted extends Error {
  override name = "PasswordAborted";
}

export async function passwordCommand(options: PasswordCommandOptions): Promise<void> {
  const { input, output } = options;
  let password: string;
  if (input.isTTY === true && input.setRawMode !== undefined) {
    password = await askHidden(input, output, "Neues Passwort für den CEO: ");
    const again = await askHidden(input, output, "Noch einmal: ");
    if (again !== password) {
      throw new Error("Die beiden Eingaben stimmen nicht überein; nichts geändert");
    }
  } else {
    password = await firstLine(input);
  }
  const stored = await hashPassword(password, options.scrypt ?? DEFAULT_SCRYPT);
  writePasswordFile(options.path, stored);
  output.write(`Passwort gespeichert in ${options.path}\n`);
}

/** Erste Zeile ohne Zeilenende. */
async function firstLine(input: Readable): Promise<string> {
  let text = "";
  for await (const chunk of input) {
    text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    if (text.includes("\n")) {
      break;
    }
  }
  return (text.split("\n")[0] ?? "").replace(/\r$/, "");
}

/** Liest eine Zeile im Raw-Modus, ohne die Zeichen anzuzeigen. Strg+C oder Strg+D brechen ab. */
function askHidden(input: PasswordInput, output: Writable, prompt: string): Promise<string> {
  output.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error: Error | null) => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      if (error === null) {
        resolve(value);
      } else {
        reject(error);
      }
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of typeof chunk === "string" ? chunk : chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          done(null);
          return;
        }
        if (char === "\u0003" || char === "\u0004") {
          done(new PasswordAborted("Abgebrochen; nichts geändert"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = Array.from(value).slice(0, -1).join("");
        } else {
          value += char;
        }
      }
    };
    input.setRawMode?.(true);
    input.on("data", onData);
    input.resume();
  });
}
