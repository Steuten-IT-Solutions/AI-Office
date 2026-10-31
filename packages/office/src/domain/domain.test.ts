import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore } from "../events/event-store.ts";
import { allowedRunTypes, parseAgentProfile, type AgentProfile } from "./agent.ts";
import { parseBuilding, totalWorkplaces } from "./building.ts";
import { mayWake } from "./message.ts";
import { DomainError, Office } from "./office.ts";
import { loadStartData, seedStartAgents, type StartData } from "./start-data.ts";
import { canTransition } from "./task.ts";
import { ValidationError } from "./validation.ts";

const CTO = "jonas-albrecht";
const CFO = "ingrid-wolters";
const COO = "deniz-kaya";
const CHRO = "amara-okafor";
const REPO = "Steuten-IT-Solutions/AI-Office";

let dir: string;
let path: string;
let start: StartData;
let store: EventStore;
let office: Office;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-domain-"));
  path = join(dir, "office.db");
  start = loadStartData();
  store = EventStore.open(path);
  office = Office.open(store, start.building);
  seedStartAgents(office, start.agents);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function profile(id: string): AgentProfile {
  return structuredClone(office.state.agent(id) as AgentProfile);
}

function reopen(): Office {
  store.close();
  store = EventStore.open(path);
  return Office.open(store, start.building);
}

describe("Startdaten", () => {
  it("enthalten die vier Startagenten aus Kap. 5.12", () => {
    expect(start.agents.map((a) => [a.id, a.role, a.models.default])).toEqual([
      [CHRO, "CHRO", "sonnet"],
      [COO, "COO", "sonnet"],
      [CFO, "CFO", "sonnet"],
      [CTO, "CTO", "sonnet"],
    ]);
    const cto = start.agents.find((a) => a.id === CTO) as AgentProfile;
    expect(cto.temperament).toEqual({
      openness: 3,
      conscientiousness: 5,
      extraversion: 2,
      agreeableness: 3,
      resilience: 4,
    });
    expect(cto.models.additional).toEqual([{ model: "opus", purpose: "Architektur" }]);
  });

  it("geben nur dem CTO eine Werkbank (Kap. 5.12, E44)", () => {
    const withWorkbench = start.agents.filter((a) =>
      allowedRunTypes(a.equipment).includes("werkbank"),
    );
    expect(withWorkbench.map((a) => a.id)).toEqual([CTO]);
  });

  it("beschreiben das Gebäude im Startzustand aus Kap. 5.6", () => {
    const rooms = start.building.floors.flatMap((f) => f.rooms.map((r) => r.id));
    expect(start.building.floors).toHaveLength(1);
    expect(rooms).toEqual([
      "eingang",
      "eingangsbereich",
      "buero-ceo",
      "buero-coo",
      "buero-cto",
      "buero-cfo",
      "buero-chro",
    ]);
    expect(totalWorkplaces(start.building)).toBe(4);
  });

  it("werden als agent.hired eingestellt, ein zweites Mal nicht", () => {
    expect(office.state.agents()).toHaveLength(4);
    expect(store.read({ types: ["agent.hired"] })).toHaveLength(4);
    expect(seedStartAgents(office, start.agents)).toEqual([]);
    expect(store.read()).toHaveLength(4);
    expect(office.state.skipped).toEqual([]);
  });
});

describe("Profile", () => {
  it("melden alle Fehler auf einmal, auch unbekannte Felder", () => {
    const raw = { ...profile(CTO), age: 7, extra: true, models: { default: "gpt" } };
    const result = parseAgentProfile(raw);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues).toEqual(
      expect.arrayContaining([
        "profil.extra: unbekanntes Feld",
        "profil.age: ganze Zahl von 18 bis 99 erwartet",
        "profil.models.default: einer von haiku, sonnet, opus erwartet",
        "profil.models.additional: Liste erwartet",
      ]),
    );
  });

  it("sind versioniert: jede Änderung erhöht die Version um genau 1", () => {
    const changed = { ...profile(CFO), version: 2, attitude: "Kosten zuerst." };
    office.changeProfile("ceo", changed);
    expect(office.state.agent(CFO)?.attitude).toBe("Kosten zuerst.");
    expect(office.state.profileHistory(CFO).map((p) => p.version)).toEqual([1, 2]);

    expect(() => office.changeProfile("ceo", { ...changed, version: 4 })).toThrow(
      new DomainError("Version 3 erwartet, nicht 4"),
    );
  });

  it("lehnen Ausstattung ab, die der Raum nicht hat", () => {
    const cfo = { ...profile(CFO), version: 2, equipment: ["werkbank" as const] };
    expect(() => office.changeProfile("ceo", cfo)).toThrow(
      new DomainError("Raum buero-cfo hat keine Ausstattung werkbank"),
    );
  });

  it("lehnen Ringe in der Berichtslinie ab", () => {
    office.changeProfile("ceo", { ...profile(COO), version: 2, supervisorId: CTO });
    expect(() =>
      office.changeProfile("ceo", { ...profile(CTO), version: 2, supervisorId: COO }),
    ).toThrow(new DomainError("Berichtslinie bildet einen Ring"));
  });

  it("lehnen doppelte Einstellung und unbekannte Vorgesetzte ab", () => {
    expect(() => office.hireAgent("ceo", profile(CTO))).toThrow(
      new DomainError(`Agent ${CTO} existiert bereits`),
    );
    const newcomer = { ...profile(CFO), id: "neu", supervisorId: "niemand" };
    expect(() => office.hireAgent("ceo", newcomer)).toThrow(
      new DomainError("Vorgesetzter niemand existiert nicht"),
    );
  });
});

describe("Aufgaben", () => {
  it("entstehen offen und wechseln Bearbeiter und Status", () => {
    const task = office.createTask("ceo", {
      title: "Startseite",
      description: "Eine schlichte Startseite bauen",
      runType: "buero",
      assigneeId: COO,
    });
    expect(task).toMatchObject({ status: "offen", assigneeId: COO, createdBy: "ceo" });

    const sub = office.createTask(COO, {
      title: "Umsetzung",
      description: "Code schreiben",
      runType: "werkbank",
      repo: REPO,
      parentTaskId: task.id,
    });
    expect(office.delegateTask(COO, sub.id, CTO).assigneeId).toBe(CTO);
    expect(office.changeTaskStatus(CTO, sub.id, "in_arbeit").status).toBe("in_arbeit");
    expect(office.changeTaskStatus(CTO, sub.id, "erledigt", "PR offen").status).toBe("erledigt");
  });

  it("delegieren werkbank-Aufgaben nur an Agenten mit Werkbank", () => {
    const task = office.createTask(COO, {
      title: "Fix",
      description: "Fehler beheben",
      runType: "werkbank",
      repo: REPO,
    });
    expect(() => office.delegateTask(COO, task.id, CFO)).toThrow(
      new DomainError(`Agent ${CFO} hat keine Ausstattung für den Lauftyp werkbank`),
    );
  });

  it("verlangen ein Repo genau für werkbank-Aufgaben", () => {
    expect(() =>
      office.createTask(COO, { title: "A", description: "B", runType: "werkbank" }),
    ).toThrow(ValidationError);
    expect(() =>
      office.createTask(COO, { title: "A", description: "B", runType: "buero", repo: REPO }),
    ).toThrow(ValidationError);
  });

  it("zählen Wiedereröffnungen und erlauben aus abgeschlossenen Zuständen nur offen", () => {
    const task = office.createTask("ceo", { title: "A", description: "B", runType: "buero" });
    office.changeTaskStatus(COO, task.id, "erledigt");
    expect(() => office.changeTaskStatus(COO, task.id, "in_arbeit")).toThrow(DomainError);
    office.changeTaskStatus("ceo", task.id, "offen");
    office.changeTaskStatus(COO, task.id, "abgebrochen");
    expect(office.changeTaskStatus("ceo", task.id, "offen").reopenCount).toBe(2);
    expect(canTransition("offen", "offen")).toBe(false);
  });
});

describe("Nachrichten", () => {
  it("haben eine Art, und nur info weckt nicht (E32)", () => {
    expect(mayWake("auftrag")).toBe(true);
    expect(mayWake("frage")).toBe(true);
    expect(mayWake("info")).toBe(false);

    const question = office.sendMessage(CTO, { toId: "ceo", kind: "frage", text: "Welche DB?" });
    const answer = office.sendMessage("ceo", {
      toId: CTO,
      kind: "info",
      text: "SQLite",
      replyToId: question.id,
    });
    expect(answer).toMatchObject({
      fromId: "ceo",
      toId: CTO,
      kind: "info",
      replyToId: question.id,
    });
    expect(office.state.messages({ toId: CTO }).map((m) => m.text)).toEqual(["SQLite"]);
    expect(office.state.messages({ afterSeq: question.seq })).toEqual([answer]);
  });

  it("lehnen unbekannte Empfänger, Selbstgespräche und falsche Arten ab", () => {
    expect(() => office.sendMessage(CTO, { toId: "x", kind: "info", text: "a" })).toThrow(
      new DomainError("Empfänger x ist unbekannt"),
    );
    expect(() => office.sendMessage(CTO, { toId: CTO, kind: "info", text: "a" })).toThrow(
      new DomainError("Absender und Empfänger sind gleich"),
    );
    expect(() =>
      office.sendMessage(CTO, { toId: COO, kind: "befehl" as "info", text: "a" }),
    ).toThrow(ValidationError);
  });
});

describe("Ereignisprotokoll", () => {
  it("ergibt nach erneutem Öffnen denselben Zustand", () => {
    const task = office.createTask("ceo", { title: "A", description: "B", runType: "buero" });
    office.delegateTask("ceo", task.id, COO);
    office.sendMessage("ceo", { toId: COO, kind: "auftrag", text: "Bitte", taskId: task.id });
    office.changeProfile("ceo", { ...profile(CHRO), version: 2, age: 45 });

    const again = reopen();
    expect(again.state.agents()).toEqual(office.state.agents());
    expect(again.state.tasks()).toEqual(office.state.tasks());
    expect(again.state.messages()).toEqual(office.state.messages());
    expect(again.state.lastSeq).toBe(store.head().seq);
    expect(store.verifyChain().ok).toBe(true);
  });

  it("ist bei gleichem Idempotenzschlüssel idempotent", () => {
    const input = { toId: COO, kind: "auftrag" as const, text: "Los" };
    const options = { runId: "r-1", idempotencyKey: "r-1:1" };
    const first = office.sendMessage(CTO, input, options);
    expect(office.sendMessage(CTO, input, options)).toEqual(first);
    expect(office.state.messages()).toHaveLength(1);
    expect(() => office.sendMessage(CTO, { ...input, text: "Anders" }, options)).toThrow(
      DomainError,
    );
  });

  it("übergeht fremde Typen still, neuere Versionen und Regelverstöße mit Grund", () => {
    store.append({ type: "run.finished", actor: "system", payload: { ok: true } });
    store.append({ type: "message.sent", version: 2, actor: CTO, payload: { neu: 1 } });
    store.append({
      type: "message.sent",
      actor: "fremd",
      payload: { toId: CTO, kind: "info", text: "x", taskId: null, replyToId: null },
    });
    store.append({ type: "task.created", actor: "ceo", payload: { title: "" } });

    const again = reopen();
    expect(again.state.skipped.map((s) => [s.type, s.reason])).toEqual([
      ["message.sent", "Version 2 ist neuer als dieser Code"],
      ["message.sent", "Absender fremd ist unbekannt"],
      ["task.created", "Payload entspricht nicht dem Schema"],
    ]);
    expect(again.state.messages()).toEqual([]);
    expect(again.state.agents()).toHaveLength(4);
  });

  it("behält Agenten, auch wenn ihr Raum später aus den Gebäudedaten fehlt", () => {
    const smaller = structuredClone(start.building);
    const floor = smaller.floors[0];
    if (floor === undefined) {
      throw new Error("Etage fehlt");
    }
    floor.rooms = floor.rooms.filter((room) => room.id !== "buero-cto");
    store.close();
    store = EventStore.open(path);
    const again = Office.open(store, smaller);
    expect(again.state.agent(CTO)?.roomId).toBe("buero-cto");
    expect(again.state.skipped).toEqual([]);
    expect(() => again.changeProfile("ceo", { ...profile(CTO), version: 2 })).toThrow(
      new DomainError("Raum buero-cto existiert nicht"),
    );
  });

  it("liest Ereignisse einer anderen Instanz vor jedem Befehl nach", () => {
    const other = Office.open(store, start.building);
    const task = other.createTask("ceo", { title: "A", description: "B", runType: "buero" });
    expect(office.delegateTask("ceo", task.id, COO).assigneeId).toBe(COO);
  });
});

describe("Gebäude", () => {
  it("lehnt doppelte IDs und leere Gebäude ab", () => {
    const room = { id: "r", name: "R", kind: "buero", workplaces: 1, equipment: [] };
    const result = parseBuilding({
      id: "g",
      name: "G",
      floors: [{ id: "r", name: "E", rooms: [room] }],
    });
    expect(result.ok ? [] : result.issues).toEqual(["gebaeude: ID r ist doppelt vergeben"]);
    expect(parseBuilding({ id: "g", name: "G", floors: [] }).ok).toBe(false);
  });
});
