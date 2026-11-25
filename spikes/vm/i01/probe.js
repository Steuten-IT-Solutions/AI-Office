// Abnahme I01: ein Antrag über den IPC-Socket des Supervisors, als aio-office, mit dem
// Probe-Profil „coo“ aus S05 (Lauftyp buero, Modell haiku). So entsteht ein echter Lauf, ohne dass
// das Office ihn beantragt; das Office sieht den Lauf nicht in seiner Zeitleiste.
//
// Aufruf (als aio-office): node probe.js "<Prompt>"
// Ausgabe je Zeile, mit Zeitstempel in ms seit 1970:
//   entscheidung <ms> {"decision": …}
//   gestartet <ms> <runId>         nach dem Abruf des Tokens (dann startet der Container)
//   erste_ausgabe <ms>              erste Zeile des CLI (Init), der Lauf arbeitet
//   ergebnis <ms> {"is_error": …, "kosten": …}
//   ende <ms> {…}                   Ende laut Supervisor (Grund, Exit)
// Gibt nie das Office-Token aus.
import { connect } from "node:net";

const prompt = process.argv[2];
if (prompt === undefined || prompt === "") {
  console.error("Aufruf: node probe.js <Prompt>");
  process.exit(2);
}

const sock = connect("/run/aio/supervisor.sock");
let buf = "";
let n = 0;
const waiting = new Map();
sock.setEncoding("utf8");
sock.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  }
});
const call = (method, params) =>
  new Promise((res) => {
    const id = `i01-${String(++n)}`;
    waiting.set(id, res);
    sock.write(JSON.stringify({ v: 1, id, method, params }) + "\n");
  });
const say = (what, rest = "") => {
  console.log(`${what} ${String(Date.now())}${rest === "" ? "" : " " + rest}`);
};

await new Promise((r) => sock.once("connect", r));
const req = await call("run.request", {
  agentId: "coo",
  runType: "buero",
  taskId: null,
  repo: null,
  model: "haiku",
  prompt,
});
if (!req.ok) {
  say("entscheidung", JSON.stringify({ decision: "fehler", reason: JSON.stringify(req.error) }));
  sock.end();
  process.exit(1);
}
say("entscheidung", JSON.stringify(req.result));
if (req.result.decision !== "admitted") {
  sock.end();
  process.exit(0);
}
const runId = req.result.runId;
const tok = await call("run.token", { runId });
say("gestartet", `${runId} ${String(tok.result?.state)}`);
let offset = 0;
let first = true;
for (let i = 0; i < 600; i++) {
  const r = await call("run.output", { runId, offset });
  const o = r.result;
  if (o === undefined || o.state === "unknown") {
    say("ende", JSON.stringify({ fehler: r.error ?? "unknown" }));
    break;
  }
  for (const line of (o.data ?? "").split("\n").filter(Boolean)) {
    if (first) {
      say("erste_ausgabe");
      first = false;
    }
    try {
      const j = JSON.parse(line);
      if (j.type === "result") {
        say("ergebnis", JSON.stringify({ is_error: j.is_error, kosten: j.total_cost_usd }));
      }
    } catch {
      // Keine JSON-Zeile: zählt nur als Ausgabe.
    }
  }
  offset = o.nextOffset;
  if (o.state === "ended" && o.data === "") {
    say("ende", JSON.stringify(o.end ?? null));
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}
sock.end();
