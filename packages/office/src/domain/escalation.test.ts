import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore } from "../events/event-store.ts";
import type { AgentProfile } from "./agent.ts";
import { Office } from "./office.ts";
import { loadStartData, seedStartAgents, type StartData } from "./start-data.ts";

const CTO = "jonas-albrecht";
const COO = "deniz-kaya";

let dir: string;
let path: string;
let start: StartData;
let store: EventStore;
let office: Office;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-escalation-"));
  path = join(dir, "office.db");
  start = loadStartData();
  store = EventStore.open(path);
  office = Office.open(store, start.building);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Eskalation (Kap. 5.4, E47)", () => {
  it("behält bei einer Wiederholung den ursprünglichen Empfänger", () => {
    seedStartAgents(office, start.agents);
    const options = { runId: "r1", idempotencyKey: "r1:escalate:1" };
    const first = office.escalate(CTO, { text: "Blockiert" }, options);
    expect(first.toId).toBe(COO);
    const coo = office.state.agent(COO) as AgentProfile;
    office.changeProfile("ceo", { ...coo, version: coo.version + 1, role: "Berater" });
    expect(office.escalationTarget(CTO)).toBe("ceo");
    expect(office.escalate(CTO, { text: "Blockiert" }, options)).toEqual(first);
    expect(() => office.escalate(CTO, { text: "Anders" }, options)).toThrow("wiederverwendet");
  });

  it("geht an den CEO, solange es keinen COO gibt", () => {
    office.hireAgent("system", start.agents.find((a) => a.id === CTO) as AgentProfile);
    expect(office.cooId()).toBeNull();
    expect(office.escalate(CTO, { text: "Hilfe" }).toId).toBe("ceo");
  });

  it("geht an den COO, die des COO an den CEO, und übersteht das Einlesen", () => {
    seedStartAgents(office, start.agents);
    const task = office.createTask("ceo", {
      title: "Planung",
      description: "Plan erstellen",
      runType: "buero",
      assigneeId: CTO,
    });
    const first = office.escalate(CTO, { text: "Blockiert", taskId: task.id }, { runId: "r1" });
    expect(first).toMatchObject({ fromId: CTO, toId: COO, taskId: task.id, runId: "r1" });
    expect(office.escalate(COO, { text: "Weiter" }).toId).toBe("ceo");
    expect(() => office.escalate("ceo", { text: "x" })).toThrow("Handelnder ceo ist kein Agent");
    office.sendMessage(COO, { toId: CTO, kind: "info", text: "Erledigt", replyToId: first.id });

    store.close();
    store = EventStore.open(path);
    const again = Office.open(store, start.building);
    expect(again.state.skipped).toEqual([]);
    expect(again.state.escalations().map((e) => [e.fromId, e.toId])).toEqual([
      [CTO, COO],
      [COO, "ceo"],
    ]);
    expect(again.state.escalation(first.id)?.answeredSeq).toBe(again.state.lastSeq);
  });
});
