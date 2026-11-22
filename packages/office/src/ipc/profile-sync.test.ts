import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentProfile } from "../domain/agent.ts";
import { Office } from "../domain/office.ts";
import { loadStartData, seedStartAgents } from "../domain/start-data.ts";
import { EventStore } from "../events/event-store.ts";
import { IpcTransportError } from "./client.ts";
import { ProfileSync, profileParams, type ProfileAccess } from "./profile-sync.ts";
import type { IpcParams } from "./protocol.ts";

const COO = "deniz-kaya";
const CTO = "jonas-albrecht";

let dir: string;
let store: EventStore;
let office: Office;
let calls: { method: string; id: string }[];
/** Antwort je Raum bzw. Agent: Grund der Ablehnung, Fehler oder (fehlend) Freigabe. */
let verdicts: Map<string, string | Error>;

function verdict(id: string) {
  const v = verdicts.get(id);
  if (v instanceof Error) {
    return Promise.reject(v);
  }
  return Promise.resolve(
    v === undefined ? { allowed: true as const } : { allowed: false as const, reason: v },
  );
}

const access: ProfileAccess = {
  changeWorkplaces(params: IpcParams<"workplaces.change">) {
    calls.push({ method: "workplaces.change", id: params.roomId });
    return verdict(params.roomId);
  },
  checkProfile(params: IpcParams<"profile.check">) {
    calls.push({ method: "profile.check", id: params.agentId });
    return verdict(params.agentId);
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-profile-sync-"));
  const start = loadStartData();
  store = EventStore.open(join(dir, "office.db"));
  office = Office.open(store, start.building, { now: () => new Date("2026-11-22T08:00:00Z") });
  seedStartAgents(office, start.agents);
  calls = [];
  verdicts = new Map();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("profileParams", () => {
  it("übergibt nur die Felder der Richtlinie, Zusatzmodelle ohne Zweck und ohne Doppelte", () => {
    const cto = office.state.agent(CTO) as AgentProfile;
    const profile: AgentProfile = {
      ...cto,
      models: {
        default: "sonnet",
        additional: [
          { model: "opus", purpose: "Architektur" },
          { model: "opus", purpose: "Reviews" },
        ],
      },
    };
    expect(profileParams(profile)).toEqual({
      agentId: CTO,
      version: 1,
      role: "CTO",
      supervisorId: "ceo",
      models: { default: "sonnet", additional: ["opus"] },
      equipment: cto.equipment,
      roomId: "buero-cto",
    });
  });
});

describe("ProfileSync", () => {
  it("meldet erst die Räume mit Arbeitsplätzen, dann die Profile, und danach nur Änderungen", async () => {
    const sync = new ProfileSync({ office, access });
    const first = await sync.sync();
    expect(calls).toEqual([
      { method: "workplaces.change", id: "buero-coo" },
      { method: "workplaces.change", id: "buero-cto" },
      { method: "workplaces.change", id: "buero-cfo" },
      { method: "workplaces.change", id: "buero-chro" },
      { method: "profile.check", id: "amara-okafor" },
      { method: "profile.check", id: "deniz-kaya" },
      { method: "profile.check", id: "ingrid-wolters" },
      { method: "profile.check", id: "jonas-albrecht" },
    ]);
    expect(first.approved).toHaveLength(8);
    expect(first.rejected).toEqual([]);
    expect(first.failed).toEqual([]);

    calls = [];
    expect(await sync.sync()).toEqual({ approved: [], rejected: [], failed: [] });
    expect(calls).toEqual([]);

    const coo = office.state.agent(COO) as AgentProfile;
    office.changeProfile("ceo", {
      ...coo,
      version: 2,
      models: { default: "haiku", additional: [] },
    });
    expect((await sync.sync()).approved).toEqual([{ kind: "profil", id: COO }]);
    expect(calls).toEqual([{ method: "profile.check", id: COO }]);
  });

  it("meldet Vorgesetzte vor Mitarbeitern und hält Mitarbeiter eines abgelehnten Vorgesetzten zurück", async () => {
    const coo = office.state.agent(COO) as AgentProfile;
    office.hireAgent("ceo", {
      ...coo,
      id: "lea-brandt",
      name: "Lea Brandt",
      role: "Assistenz",
      supervisorId: COO,
      avatarSeed: "lea-brandt",
    });
    verdicts.set(COO, "Rolle COO darf sonnet nicht nutzen (erlaubt: haiku)");
    const sync = new ProfileSync({ office, access });
    const result = await sync.sync();
    const profiles = calls.filter((c) => c.method === "profile.check").map((c) => c.id);
    expect(profiles).toEqual(["amara-okafor", COO, "ingrid-wolters", CTO]);
    expect(result.rejected).toEqual([
      { kind: "profil", id: COO, reason: "Rolle COO darf sonnet nicht nutzen (erlaubt: haiku)" },
    ]);
    expect(result.failed).toEqual([
      { kind: "profil", id: "lea-brandt", error: `Vorgesetzter ${COO} nicht freigegeben` },
    ]);

    // Dieselbe Ablehnung wird nicht erneut gesendet, gilt aber weiter.
    calls = [];
    const again = await sync.sync();
    expect(calls).toEqual([]);
    expect(again.rejected).toEqual(result.rejected);
  });

  it("versucht es nach einem technischen Fehler im nächsten Durchlauf wieder", async () => {
    verdicts.set("buero-cto", new IpcTransportError("Supervisor nicht erreichbar", false));
    const sync = new ProfileSync({ office, access });
    const result = await sync.sync();
    expect(result.failed).toEqual([
      { kind: "raum", id: "buero-cto", error: "Supervisor nicht erreichbar" },
      { kind: "profil", id: CTO, error: "Raum buero-cto nicht freigegeben" },
    ]);
    verdicts.delete("buero-cto");
    calls = [];
    const next = await sync.sync();
    expect(calls).toEqual([
      { method: "workplaces.change", id: "buero-cto" },
      { method: "profile.check", id: CTO },
    ]);
    expect(next.failed).toEqual([]);
  });
});
