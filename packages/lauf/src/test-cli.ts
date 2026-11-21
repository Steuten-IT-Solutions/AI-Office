/**
 * Attrappe des CLI für die Tests des Startprozesses (E23: kein echtes LLM).
 *
 * Verhalten über Argumente: `exit <n>`, `schlafe <ms>`, `ignoriere <SIGNAL...>`, `kind` (startet
 * einen Enkelprozess und schreibt dessen PID nach stdout), `umgebung` (schreibt die Namen der
 * Umgebungsvariablen nach stdout), `stdin` (gibt stdin zurück).
 */
import { spawn } from "node:child_process";

const argumente = process.argv.slice(2);
let code = 0;
let schlafen = 0;
for (let i = 0; i < argumente.length; i += 1) {
  const a = argumente[i];
  if (a === "exit") {
    code = Number(argumente[(i += 1)]);
  } else if (a === "schlafe") {
    schlafen = Number(argumente[(i += 1)]);
  } else if (a === "ignoriere") {
    while (argumente[i + 1]?.startsWith("SIG") === true) {
      process.on(argumente[(i += 1)] as NodeJS.Signals, () => {
        process.stdout.write("signal ignoriert\n");
      });
    }
  } else if (a === "beende-bei") {
    const signal = argumente[(i += 1)] as NodeJS.Signals;
    process.on(signal, () => {
      process.stdout.write(`beende nach ${signal}\n`);
      process.exit(7);
    });
  } else if (a === "kind") {
    const enkel = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    enkel.unref();
    process.stdout.write(`enkel ${String(enkel.pid)}\n`);
  } else if (a === "umgebung") {
    process.stdout.write(`${Object.keys(process.env).sort().join(",")}\n`);
  } else if (a === "stdin") {
    process.stdin.pipe(process.stdout);
  }
}
if (schlafen > 0) {
  setTimeout(() => process.exit(code), schlafen);
} else if (!argumente.includes("stdin")) {
  process.exitCode = code;
}
