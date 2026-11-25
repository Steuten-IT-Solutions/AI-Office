import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Office } from "../domain/office.ts";
import { loadStartData, seedStartAgents } from "../domain/start-data.ts";
import { METHODS, type IpcParams } from "../ipc/protocol.ts";
import { DirectiveReporter } from "./directive-reporter.ts";
import { EventStore } from "./event-store.ts";

const CTO = "jonas-albrecht";

let dir: string;
let store: EventStore;
let office: Office;
let sent: IpcParams<"directive.report">[];
let failNext: boolean;

const access = {
  reportDirective(params: IpcParams<"directive.report">) {
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error("Socket weg"));
    }
    sent.push(params);
    return Promise.resolve({ recorded: true, auditSeq: sent.length });
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-weisung-"));
  store = EventStore.open(join(dir, "office.db"));
  const start = loadStartData();
  office = Office.open(store, start.building);
  seedStartAgents(office, start.agents);
  sent = [];
  failNext = false;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("DirectiveReporter (E38, E68)", () => {
  it("meldet Weisungen und Rücknahmen in der Reihenfolge des Protokolls, jede einmal", async () => {
    const reporter = new DirectiveReporter({ office, access });
    const a = office.issueDirective({ text: "Kleine PRs.", agentIds: null });
    const b = office.issueDirective({ text: "Erst testen.", agentIds: [CTO] });
    const revoked = office.revokeDirective(a.id);

    expect(await reporter.report()).toEqual({ sent: 3, recorded: 3, pending: 0, error: null });
    expect(sent).toEqual([
      {
        action: "issued",
        directiveId: a.id,
        text: "Kleine PRs.",
        agentIds: null,
        officeSeq: a.seq,
      },
      {
        action: "issued",
        directiveId: b.id,
        text: "Erst testen.",
        agentIds: [CTO],
        officeSeq: b.seq,
      },
      { action: "revoked", directiveId: a.id, officeSeq: revoked.revokedSeq },
    ]);
    expect(await reporter.report()).toMatchObject({ sent: 0, pending: 0 });
    expect(sent).toHaveLength(3);
  });

  it("hört beim ersten Fehler auf und meldet den Rest im nächsten Durchlauf", async () => {
    const reporter = new DirectiveReporter({ office, access });
    const a = office.issueDirective({ text: "Kleine PRs.", agentIds: null });
    office.revokeDirective(a.id);
    failNext = true;

    expect(await reporter.report()).toEqual({
      sent: 0,
      recorded: 0,
      pending: 2,
      error: "Socket weg",
    });
    expect(await reporter.report()).toMatchObject({ sent: 2, pending: 0, error: null });
    expect(sent.map((p) => p.action)).toEqual(["issued", "revoked"]);
  });

  it("schickt nur Meldungen, die das Protokoll des Supervisors annimmt", async () => {
    const reporter = new DirectiveReporter({ office, access });
    const a = office.issueDirective({ text: "Ä😀 Weisung", agentIds: [CTO] });
    office.revokeDirective(a.id);
    await reporter.report();
    for (const params of sent) {
      expect(METHODS["directive.report"].params.safeParse(params).success).toBe(true);
    }
  });
});
