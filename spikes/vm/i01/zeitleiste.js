// Abnahme I01, AK 11: Erscheint jede Handlung in der Zeitleiste mit Agent, Kosten und Zeitpunkt?
//
// Liest das Ereignisprotokoll des Office nur lesend (als aio-office) und prüft dieselben Felder,
// die GET /api/timeline ausliefert (AI-Office gateway.ts): `actor`, `occurredAt` und
// `runCostUsd` = `totalCostUsd` aus `run.finished` des Laufs, aus dem die Handlung stammt.
//
// Aufruf: node zeitleiste.js /var/lib/aio-office/office.db
// Ausgabe: eine JSON-Zeile mit Zählern und den ersten Funden.
import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
if (path === undefined) {
  console.error("Aufruf: node zeitleiste.js <office.db>");
  process.exit(2);
}
const db = new DatabaseSync(path, { readOnly: true });
const rows = db
  .prepare("SELECT seq, type, actor, run_id, occurred_at, payload FROM events ORDER BY seq")
  .all();

// Lauf → Agent (aus run.started) und Kosten (aus run.finished).
const runs = new Map();
for (const r of rows) {
  if (r.run_id === null) continue;
  const run = runs.get(r.run_id) ?? { agentId: null, cost: null, finished: false };
  const p = JSON.parse(r.payload);
  if (r.type === "run.started" && typeof p.agentId === "string") run.agentId = p.agentId;
  if (r.type === "run.finished") {
    run.finished = true;
    if (typeof p.totalCostUsd === "number") run.cost = p.totalCostUsd;
  }
  runs.set(r.run_id, run);
}

// Prüfläufe des Health-Checks (S11b) sind keine Handlung eines Agenten: Sie haben keine Kosten.
const SYSTEM_TYPES = new Set(["check_run.started", "check_run.finished"]);
const out = {
  ereignisse: rows.length,
  ausLaeufen: 0,
  ohneLauf: 0,
  pruefLaeufe: 0,
  laeufe: 0,
  laeufeOffen: 0,
  ohneAkteur: [],
  ohneZeit: [],
  ohneKosten: [],
  ohneAgent: [],
  arten: {},
};
const firstFew = (list, item) => {
  if (list.length < 10) list.push(item);
};
for (const r of rows) {
  out.arten[r.type] = (out.arten[r.type] ?? 0) + 1;
  if (typeof r.actor !== "string" || r.actor === "") firstFew(out.ohneAkteur, r.seq);
  if (Number.isNaN(Date.parse(r.occurred_at))) firstFew(out.ohneZeit, r.seq);
  if (r.run_id === null) {
    out.ohneLauf++;
    continue;
  }
  if (SYSTEM_TYPES.has(r.type)) {
    out.pruefLaeufe++;
    continue;
  }
  out.ausLaeufen++;
  const run = runs.get(r.run_id);
  if (!run.finished) continue;
  if (run.cost === null) firstFew(out.ohneKosten, `${String(r.seq)} ${r.type}`);
  if (run.agentId === null && r.actor === "system")
    firstFew(out.ohneAgent, `${String(r.seq)} ${r.type}`);
}
for (const [, run] of runs) {
  if (run.agentId === null && !run.finished) continue;
  out.laeufe++;
  if (!run.finished) out.laeufeOffen++;
}
console.log(JSON.stringify(out));
