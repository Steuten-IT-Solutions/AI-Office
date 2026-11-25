import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildContext } from "../domain/context.ts";
import type { GitMerge, GitOutcome, RunFinished } from "../domain/events.ts";
import { DomainError, Office } from "../domain/office.ts";
import { MAX_GIT_MERGE_EVENTS_PER_RUN } from "../domain/office-state.ts";
import { loadStartBooks, loadStartPersonas } from "../domain/start-content.ts";
import { loadStartData, seedStartAgents } from "../domain/start-data.ts";
import { EventStore } from "../events/event-store.ts";
import { IpcCallError, IpcTransportError } from "../ipc/client.ts";
import { MAX_FINGERPRINTS_PER_CALL, type IpcParams, type IpcResult } from "../ipc/protocol.ts";
import type { RunRequester } from "../planner/planner.ts";
import {
  FingerprintReporter,
  fingerprintsFirst,
  fingerprintsOf,
  type FingerprintAccess,
} from "./fingerprints.ts";
import { MergeStatusFollower, type MergeAccess } from "./merge-follower.ts";
import { GitOutcomeFollower, type GitAccess } from "./outcome-follower.ts";

const CTO = "jonas-albrecht";
const COO = "deniz-kaya";
const REPO = "Steuten-IT-Solutions/AI-Office";
const RUN_A = "r-00000000000000a1";
const RUN_B = "r-00000000000000b2";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

let dir: string;
let store: EventStore;
let office: Office;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-git-"));
  const start = loadStartData();
  store = EventStore.open(join(dir, "office.db"));
  const clock = new Date("2026-11-21T08:00:00.000Z");
  office = Office.open(store, start.building, { now: () => clock });
  seedStartAgents(office, start.agents);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function werkbankTask(): string {
  return office.createTask("ceo", {
    title: "Postfach bündeln",
    description: "Bitte das Postfach bündeln.",
    runType: "werkbank",
    repo: REPO,
    assigneeId: CTO,
  }).id;
}

function startRun(runId: string, taskId: string | null, agentId = CTO): void {
  office.recordRunStarted(
    {
      agentId,
      taskId,
      runType: taskId === null ? "buero" : "werkbank",
      model: "sonnet",
      inboxUpToSeq: 0,
      triggerIds: [],
    },
    { runId, idempotencyKey: `${runId}:started` },
  );
}

function finishRun(runId: string, taskId: string | null, agentId = CTO): void {
  const finished: RunFinished = {
    taskId,
    runType: taskId === null ? "buero" : "werkbank",
    model: "claude-sonnet",
    exit: "completed",
    resultSubtype: "success",
    totalCostUsd: 0.01,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    numTurns: 1,
    rateLimitStatus: null,
    invalidLines: 0,
    toolCalls: [],
    inboxUpToSeq: 0,
  };
  office.recordRunFinished(agentId, finished, { runId });
}

const OPENED: GitOutcome = {
  state: "pr_opened",
  branch: `agent/${RUN_A}`,
  head: HEAD,
  pr: 42,
  url: "https://github.com/Steuten-IT-Solutions/AI-Office/pull/42",
  reason: null,
};

class FakeGit implements GitAccess {
  readonly answers = new Map<string, IpcResult<"git.status">>();
  readonly calls: string[] = [];
  fail: Error | null = null;

  status(runId: string): Promise<IpcResult<"git.status">> {
    this.calls.push(runId);
    if (this.fail !== null) {
      return Promise.reject(this.fail);
    }
    return Promise.resolve(this.answers.get(runId) ?? { state: "unknown" });
  }
}

class FakePrints implements FingerprintAccess {
  readonly received: IpcParams<"fingerprints.add">[] = [];
  readonly stored = new Set<string>();
  failNext = 0;

  addFingerprints(params: IpcParams<"fingerprints.add">): Promise<IpcResult<"fingerprints.add">> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new IpcTransportError("Verbindung abgebrochen", true));
    }
    this.received.push(params);
    const before = this.stored.size;
    params.hashes.forEach((h) => this.stored.add(h));
    return Promise.resolve({ added: this.stored.size - before, total: this.stored.size });
  }

  has(text: string): boolean {
    return fingerprintsOf(text).every((h) => this.stored.has(h));
  }
}

describe("fingerprintsOf", () => {
  // Werte aus `fingerprintsOf` im Supervisor (packages/supervisor/src/git-gate/outbound-filter.ts,
  // Stand e24f278), dort am 21.11.2026 mit Node 24 berechnet. Weicht das Office ab, findet das
  // Gate die Abdrücke nie.
  it("rechnet wie der Supervisor", () => {
    expect(fingerprintsOf("Der CEO möchte die Preise für Ölförderung im Jahr 2027 senken")).toEqual(
      [
        "1161ea4b864c88402d97c637b24382e64763afd694bcd2d06e93ee613f1faeef",
        "466df369d79d57d7255572c491dff028ac2fc427378ff427910f09f7fb1474cf",
        "a33fc15cf175982a53a0446247f83b041d6006c3f39ba8c1830f1fba69fc02cb",
        "9dc85110662a1b45e5cff99f933287dc4683a083f33afd89d6540038d1b18623",
      ],
    );
    // NFKC (Vollbreite), Großbuchstaben, Satzzeichen und Unterstrich trennen Wörter.
    expect(
      fingerprintsOf("Ｆｕｌｌｗｉｄｔｈ ÄRGER: eins-zwei drei_vier fünf. sechs sieben acht!"),
    ).toEqual([
      "b4a6d15813e2864c5fc74415545787aab9a81d18c12058f6d716f37dc17de45d",
      "6099f479c81db6ac2b3a5b8ad1a52832d0b37666aac551393dc76645968a8814",
      "8461e22c70e21d21d7919bc6ebeea46d62f32dd614fc1b0267d8a88b3b9d63fb",
    ]);
    expect(fingerprintsOf("zu kurz")).toEqual([]);
  });
});

describe("git.outcome", () => {
  it("hält den endgültigen Stand einmal je beendetem Werkbank-Lauf fest", () => {
    const taskId = werkbankTask();
    startRun(RUN_A, taskId);
    expect(() => office.recordGitOutcome(RUN_A, OPENED)).toThrow(/noch nicht abgeschlossen/);
    finishRun(RUN_A, taskId);
    const record = office.recordGitOutcome(RUN_A, OPENED);
    expect(record).toMatchObject({ ...OPENED, runId: RUN_A, taskId });
    // Wiederholung mit gleichem Inhalt ist idempotent, anderer Inhalt nicht.
    expect(office.recordGitOutcome(RUN_A, OPENED).seq).toBe(record.seq);
    expect(() =>
      office.recordGitOutcome(RUN_A, { ...OPENED, pr: 43, url: `${OPENED.url as string}3` }),
    ).toThrow(DomainError);
    expect(office.state.latestGitOutcome(taskId)?.runId).toBe(RUN_A);
  });

  it("prüft die Felder je Stand", () => {
    const taskId = werkbankTask();
    startRun(RUN_A, taskId);
    finishRun(RUN_A, taskId);
    const none = { state: "none", branch: null, head: null, pr: null, url: null, reason: null };
    expect(() => office.recordGitOutcome(RUN_A, { ...OPENED, url: "http://x.example/1" })).toThrow(
      /url/,
    );
    expect(() => office.recordGitOutcome(RUN_A, { ...OPENED, branch: "main" })).toThrow(/branch/);
    expect(() => office.recordGitOutcome(RUN_A, { ...none, state: "rejected" })).toThrow(/reason/);
    expect(() => office.recordGitOutcome(RUN_A, { ...none, pr: 3 } as GitOutcome)).toThrow(
      /nur bei pr_opened/,
    );
  });

  it("gilt nicht für Büro-Läufe", () => {
    startRun(RUN_B, null, COO);
    finishRun(RUN_B, null, COO);
    expect(() =>
      office.recordGitOutcome(RUN_B, {
        state: "none",
        branch: null,
        head: null,
        pr: null,
        url: null,
        reason: null,
      }),
    ).toThrow(/kein Werkbank-Lauf/);
  });
});

describe("GitOutcomeFollower", () => {
  it("fragt nur beendete Werkbank-Läufe und schreibt nur endgültige Stände", async () => {
    const git = new FakeGit();
    const follower = new GitOutcomeFollower({ office, access: git });
    const taskId = werkbankTask();
    startRun(RUN_A, taskId);
    startRun(RUN_B, null, COO);
    finishRun(RUN_B, null, COO);

    // Lauf A läuft noch, Lauf B ist ein Büro-Lauf: keine Frage.
    expect(await follower.poll()).toEqual({
      recorded: [],
      pending: [],
      failed: [],
      unavailable: false,
    });
    expect(git.calls).toEqual([]);

    finishRun(RUN_A, taskId);
    git.answers.set(RUN_A, { state: "pending", attempts: 1, lastError: "GitHub antwortet nicht" });
    expect((await follower.poll()).pending).toEqual([{ runId: RUN_A, state: "pending" }]);
    git.answers.set(RUN_A, { state: "pushed", branch: `agent/${RUN_A}`, head: HEAD });
    expect((await follower.poll()).pending).toEqual([{ runId: RUN_A, state: "pushed" }]);
    expect(office.state.gitOutcome(RUN_A)).toBeUndefined();

    git.answers.set(RUN_A, {
      state: "pr_opened",
      branch: `agent/${RUN_A}`,
      head: HEAD,
      pr: 42,
      url: OPENED.url as string,
    });
    const done = await follower.poll();
    expect(done.recorded.map((r) => r.state)).toEqual(["pr_opened"]);
    expect(office.state.gitOutcome(RUN_A)).toMatchObject(OPENED);

    // Danach wird nicht mehr gefragt.
    git.calls.length = 0;
    await follower.poll();
    expect(git.calls).toEqual([]);
  });

  it("hält Ablehnungen mit Grund fest", async () => {
    const git = new FakeGit();
    const taskId = werkbankTask();
    startRun(RUN_A, taskId);
    finishRun(RUN_A, taskId);
    git.answers.set(RUN_A, { state: "rejected", reason: "fingerabdruck in PR-Text" });
    await new GitOutcomeFollower({ office, access: git }).poll();
    expect(office.state.gitOutcome(RUN_A)).toMatchObject({
      state: "rejected",
      reason: "fingerabdruck in PR-Text",
    });
  });

  it("bricht ohne Git-Gate ab und meldet Fehler je Lauf", async () => {
    const git = new FakeGit();
    const follower = new GitOutcomeFollower({ office, access: git });
    const taskId = werkbankTask();
    startRun(RUN_A, taskId);
    finishRun(RUN_A, taskId);

    git.fail = new IpcCallError(
      "git.status",
      { code: "not_available", message: "kein Git-Gate" },
      true,
    );
    expect((await follower.poll()).unavailable).toBe(true);

    git.fail = new IpcTransportError("Verbindung abgebrochen", true);
    const result = await follower.poll();
    expect(result.unavailable).toBe(false);
    expect(result.failed).toEqual([{ runId: RUN_A, error: "Verbindung abgebrochen" }]);
    expect(office.state.gitOutcome(RUN_A)).toBeUndefined();
  });
});

describe("Kontext des nächsten Laufs", () => {
  const books = loadStartBooks();
  const personas = loadStartPersonas();

  function prompt(taskId: string): string {
    return buildContext({
      state: office.state,
      agentId: CTO,
      taskId,
      constitution: "# Verfassung",
      directives: [],
      books,
      personas,
    }).prompt;
  }

  it("zeigt PR oder Ablehnung der letzten Übergabe zur Aufgabe", () => {
    const taskId = werkbankTask();
    expect(prompt(taskId)).toContain("Noch keine abgeschlossene Übergabe zu dieser Aufgabe.");

    startRun(RUN_A, taskId);
    finishRun(RUN_A, taskId);
    office.recordGitOutcome(RUN_A, {
      state: "rejected",
      branch: null,
      head: null,
      pr: null,
      url: null,
      reason: "fingerabdruck in PR-Text",
    });
    const rejected = prompt(taskId);
    expect(rejected).toContain(`Lauf \`${RUN_A}\``);
    expect(rejected).toContain(
      "vom Git-Gate abgelehnt, nichts gepusht. Grund:\n\n> fingerabdruck in PR-Text",
    );

    startRun(RUN_B, taskId);
    finishRun(RUN_B, taskId);
    office.recordGitOutcome(RUN_B, { ...OPENED, branch: `agent/${RUN_B}` });
    expect(prompt(taskId)).toContain(`PR #42 ist offen: ${OPENED.url as string}`);
  });

  it("zeigt den Merge-Stand des letzten PR, auch nach einem Lauf ohne Übergabe", () => {
    const taskId = werkbankTask();
    expect(prompt(taskId)).not.toContain("## Merge-Stand");

    startRun(RUN_A, taskId);
    finishRun(RUN_A, taskId);
    office.recordGitOutcome(RUN_A, OPENED);
    expect(prompt(taskId)).toContain(
      `## Merge-Stand\n\nPR #42 aus Lauf \`${RUN_A}\`: Kein Merge-Antrag bekannt.`,
    );

    // Lauf B beantragt nur den Merge und übergibt nichts.
    startRun(RUN_B, taskId);
    finishRun(RUN_B, taskId);
    office.recordGitOutcome(RUN_B, {
      state: "none",
      branch: null,
      head: null,
      pr: null,
      url: null,
      reason: null,
    });
    office.recordGitMerge(RUN_A, {
      ...WAITING,
      waitingFor: "checks_failed",
      reason: "Pflicht-Checks nicht grün: check",
    });
    const failed = prompt(taskId);
    expect(failed).toContain("Der Lauf hat nichts übergeben.");
    expect(failed).toContain(
      "wartet im Merge-Gate auf grüne Pflicht-Checks, sie sind fehlgeschlagen. Grund:\n\n> Pflicht-Checks nicht grün: check",
    );
    expect(failed).toContain("Ein neuer Stand kommt aus einem neuen Lauf mit neuem PR.");

    office.recordGitMerge(RUN_A, MERGED);
    expect(prompt(taskId)).toContain(
      `vom Supervisor gemergt als \`${MERGE_SHA}\`, Release-Tag \`${MERGED.tag as string}\`.`,
    );
  });

  it("zeigt Sperre und Schließen mit Grund", () => {
    const taskId = openedPr();
    office.recordGitMerge(RUN_A, {
      state: "closed",
      pr: 42,
      waitingFor: null,
      reason: "Der PR wurde ohne Merge geschlossen",
      mergeSha: null,
      tag: null,
    });
    expect(prompt(taskId)).toContain(
      "ohne Merge geschlossen. Grund:\n\n> Der PR wurde ohne Merge geschlossen",
    );
  });
});

const MERGE_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const WAITING: GitMerge = {
  state: "waiting",
  pr: 42,
  waitingFor: "approval",
  reason: "Kein Approve des CEO",
  mergeSha: null,
  tag: null,
};
const MERGED: GitMerge = {
  state: "merged",
  pr: 42,
  waitingFor: null,
  reason: null,
  mergeSha: MERGE_SHA,
  tag: "release-20261121-203410-fedcba9",
};

class FakeMerge implements MergeAccess {
  readonly answers = new Map<string, IpcResult<"git.merge_status">>();
  readonly calls: string[] = [];
  fail: Error | null = null;

  mergeStatus(runId: string): Promise<IpcResult<"git.merge_status">> {
    this.calls.push(runId);
    if (this.fail !== null) {
      return Promise.reject(this.fail);
    }
    return Promise.resolve(this.answers.get(runId) ?? { state: "none" });
  }
}

/** Werkbank-Lauf A mit offenem PR #42 zu einer neuen Aufgabe. */
function openedPr(): string {
  const taskId = werkbankTask();
  startRun(RUN_A, taskId);
  finishRun(RUN_A, taskId);
  office.recordGitOutcome(RUN_A, OPENED);
  return taskId;
}

describe("git.merge", () => {
  it("hält neue Stände zum PR einer Übergabe fest, nach einem endgültigen keinen mehr", () => {
    const taskId = werkbankTask();
    startRun(RUN_A, taskId);
    finishRun(RUN_A, taskId);
    expect(() => office.recordGitMerge(RUN_A, WAITING)).toThrow(/keinen PR geöffnet/);
    office.recordGitOutcome(RUN_A, OPENED);
    expect(() => office.recordGitMerge(RUN_A, { ...WAITING, pr: 43 })).toThrow(
      /stammt nicht aus der Übergabe/,
    );

    const first = office.recordGitMerge(RUN_A, WAITING);
    expect(first).toMatchObject({ ...WAITING, runId: RUN_A, taskId });
    expect(() => office.recordGitMerge(RUN_A, WAITING)).toThrow(/unverändert/);
    // Ein anderer Grund bei gleichem Wartegrund ist ein neuer Stand (z. B. Änderungen verlangt).
    office.recordGitMerge(RUN_A, { ...WAITING, reason: "Der CEO hat Änderungen verlangt" });
    office.recordGitMerge(RUN_A, MERGED);
    expect(office.state.gitMerges(RUN_A).map((m) => m.state)).toEqual([
      "waiting",
      "waiting",
      "merged",
    ]);
    expect(office.state.gitMerge(RUN_A)).toMatchObject(MERGED);
    expect(() => office.recordGitMerge(RUN_A, WAITING)).toThrow(/schon endgültig/);
  });

  it("ein Merge erledigt die Aufgabe des Laufs, andere Stände nicht (E66)", () => {
    const taskId = werkbankTask();
    startRun(RUN_A, taskId);
    finishRun(RUN_A, taskId);
    office.recordGitOutcome(RUN_A, OPENED);
    office.recordGitMerge(RUN_A, WAITING);
    expect(office.state.task(taskId)?.status).toBe("offen");
    office.recordGitMerge(RUN_A, MERGED);
    expect(office.state.task(taskId)?.status).toBe("erledigt");
    const change = store
      .read({ afterSeq: 0, limit: 10_000 })
      .filter((e) => e.type === "task.status_changed");
    expect(change).toHaveLength(1);
    expect(change[0]).toMatchObject({ actor: "system", runId: RUN_A });
    expect(JSON.stringify(change[0]?.payload)).toContain(`PR #${String(OPENED.pr)} gemergt`);
  });

  it("prüft die Felder je Stand", () => {
    openedPr();
    const base = { pr: 42, waitingFor: null, reason: null, mergeSha: null, tag: null };
    expect(() => office.recordGitMerge(RUN_A, { ...WAITING, waitingFor: null })).toThrow(
      /waitingFor/,
    );
    expect(() => office.recordGitMerge(RUN_A, { ...MERGED, mergeSha: null })).toThrow(/mergeSha/);
    expect(() => office.recordGitMerge(RUN_A, { ...MERGED, tag: "v1.0" })).toThrow(/tag/);
    expect(() => office.recordGitMerge(RUN_A, { ...base, state: "blocked" })).toThrow(/reason/);
    expect(() =>
      office.recordGitMerge(RUN_A, { ...base, state: "blocked", reason: "x", mergeSha: MERGE_SHA }),
    ).toThrow(/nur bei merged und closed/);
    expect(() => office.recordGitMerge(RUN_A, { ...WAITING, tag: MERGED.tag })).toThrow(
      /nur bei merged/,
    );
  });

  it("schreibt nur das System", () => {
    openedPr();
    // `recordGitMerge` schreibt immer als `system`; der Prüfer lehnt andere Handelnde ab.
    expect(
      office.state.check({ type: "git.merge", actor: CTO, payload: WAITING, runId: RUN_A }),
    ).toMatch(/nur das System/);
  });

  it("nimmt nach der Höchstzahl nur noch einen endgültigen Stand an", () => {
    openedPr();
    for (let i = 0; i < MAX_GIT_MERGE_EVENTS_PER_RUN - 1; i += 1) {
      office.recordGitMerge(RUN_A, { ...WAITING, reason: `Stand ${String(i)}` });
    }
    expect(() => office.recordGitMerge(RUN_A, { ...WAITING, reason: "noch einer" })).toThrow(
      /nur noch einen endgültigen/,
    );
    expect(office.recordGitMerge(RUN_A, MERGED).state).toBe("merged");
  });
});

describe("MergeStatusFollower", () => {
  it("fragt nur PRs aus Übergaben und schreibt nur neue Stände", async () => {
    const merge = new FakeMerge();
    const follower = new MergeStatusFollower({ office, access: merge });
    const taskId = werkbankTask();
    startRun(RUN_A, taskId);
    finishRun(RUN_A, taskId);

    // Noch kein git.outcome: keine Frage.
    expect(await follower.poll()).toEqual({
      recorded: [],
      open: [],
      failed: [],
      unavailable: false,
    });
    expect(merge.calls).toEqual([]);

    office.recordGitOutcome(RUN_A, OPENED);
    expect((await follower.poll()).open).toEqual([{ runId: RUN_A, state: "none" }]);
    expect(office.state.gitMerge(RUN_A)).toBeUndefined();

    merge.answers.set(RUN_A, {
      state: "waiting",
      pr: 42,
      waitingFor: "github",
      reason: "fetch failed",
    });
    expect((await follower.poll()).recorded.map((r) => r.waitingFor)).toEqual(["github"]);
    // Andere Fehlermeldung von GitHub: kein neuer Stand.
    merge.answers.set(RUN_A, {
      state: "waiting",
      pr: 42,
      waitingFor: "github",
      reason: "HTTP 502",
    });
    expect((await follower.poll()).open).toEqual([{ runId: RUN_A, state: "waiting" }]);

    merge.answers.set(RUN_A, {
      state: "merged",
      pr: 42,
      mergeSha: MERGE_SHA,
      tag: MERGED.tag,
    });
    expect((await follower.poll()).recorded.map((r) => r.state)).toEqual(["merged"]);
    expect(office.state.gitMerges(RUN_A)).toHaveLength(2);

    // Danach wird nicht mehr gefragt.
    merge.calls.length = 0;
    await follower.poll();
    expect(merge.calls).toEqual([]);
  });

  it("hält Sperre und Schließen mit Grund fest", async () => {
    const merge = new FakeMerge();
    openedPr();
    merge.answers.set(RUN_A, { state: "blocked", pr: 42, reason: "Der PR ändert .github/" });
    await new MergeStatusFollower({ office, access: merge }).poll();
    expect(office.state.gitMerge(RUN_A)).toMatchObject({
      state: "blocked",
      reason: "Der PR ändert .github/",
      mergeSha: null,
    });
  });

  it("verfolgt PRs nur bis zur Frist", async () => {
    const merge = new FakeMerge();
    openedPr();
    await new MergeStatusFollower({ office, access: merge, followDays: 0 }).poll();
    // Übergabe und Uhr stehen auf demselben Zeitpunkt: noch in der Frist.
    expect(merge.calls).toEqual([RUN_A]);
    merge.calls.length = 0;
    await new MergeStatusFollower({ office, access: merge, followDays: -1 }).poll();
    expect(merge.calls).toEqual([]);
  });

  it("bricht ohne Merge-Gate ab und meldet Fehler je Lauf", async () => {
    const merge = new FakeMerge();
    const follower = new MergeStatusFollower({ office, access: merge });
    openedPr();

    merge.fail = new IpcCallError(
      "git.merge_status",
      { code: "not_available", message: "kein Merge-Gate" },
      true,
    );
    expect((await follower.poll()).unavailable).toBe(true);

    merge.fail = new IpcTransportError("Verbindung abgebrochen", true);
    const result = await follower.poll();
    expect(result.unavailable).toBe(false);
    expect(result.failed).toEqual([{ runId: RUN_A, error: "Verbindung abgebrochen" }]);
    expect(office.state.gitMerge(RUN_A)).toBeUndefined();
  });
});

describe("FingerprintReporter", () => {
  const CEO_TEXT = "Unser Kunde Nordlicht zahlt ab März nur noch die Hälfte der Gebühren";
  const NOTE_TEXT = "Stand: Bündelung gebaut, Tests für leere Postfächer fehlen noch im Paket";
  const OWN_TEXT = "Ich habe das Postfach jetzt gebündelt und dazu einen Test geschrieben";

  it("meldet CEO-Chat und Übergabenotizen, nichts anderes", async () => {
    const prints = new FakePrints();
    const reporter = new FingerprintReporter({ office, access: prints });
    office.sendMessage("ceo", { toId: COO, kind: "info", text: CEO_TEXT });
    office.sendMessage(COO, {
      toId: CTO,
      kind: "info",
      text: "Nachricht zwischen zwei Agenten ganz ohne den CEO und lang genug",
    });
    const taskId = werkbankTask();
    startRun(RUN_B, null, COO);
    office.escalate(
      COO,
      { text: "Eskalation des COO an den CEO mit genug Wörtern drin" },
      {
        runId: RUN_B,
      },
    );
    finishRun(RUN_B, null, COO);
    // Übergabenotiz aus einem früheren, abgeschlossenen Werkbank-Lauf.
    startRun(RUN_A, taskId);
    office.writeHandover(CTO, taskId, NOTE_TEXT, { runId: RUN_A });
    finishRun(RUN_A, taskId);
    office.recordGitOutcome(RUN_A, OPENED);

    const report = await reporter.report();
    expect(report).toMatchObject({ unsent: 0, deferred: 0, error: null });
    expect(prints.has(CEO_TEXT)).toBe(true);
    expect(prints.has("Eskalation des COO an den CEO mit genug Wörtern drin")).toBe(true);
    expect(prints.has(NOTE_TEXT)).toBe(true);
    expect(prints.has("Nachricht zwischen zwei Agenten ganz ohne den CEO und lang genug")).toBe(
      false,
    );
    expect(prints.received.map((r) => r.source).sort()).toEqual(["ceo_chat", "memory"]);
    // Kein Klartext im Aufruf.
    expect(JSON.stringify(prints.received)).not.toContain("Nordlicht");

    // Nur Neues wird gesendet.
    const before = prints.received.length;
    expect((await reporter.report()).sent).toBe(0);
    expect(prints.received.length).toBe(before);
  });

  it("stellt Texte eines Werkbank-Laufs zurück, bis seine Übergabe abgeschlossen ist", async () => {
    const prints = new FakePrints();
    const reporter = new FingerprintReporter({ office, access: prints });
    const taskId = werkbankTask();
    startRun(RUN_A, taskId);
    office.writeHandover(CTO, taskId, OWN_TEXT, { runId: RUN_A });
    office.sendMessage(CTO, { toId: "ceo", kind: "info", text: OWN_TEXT }, { runId: RUN_A });

    expect(await reporter.report()).toMatchObject({ sent: 0, deferred: 2 });
    finishRun(RUN_A, taskId);
    expect((await reporter.report()).deferred).toBe(2);
    expect(prints.has(OWN_TEXT)).toBe(false);

    office.recordGitOutcome(RUN_A, OPENED);
    expect(await reporter.report()).toMatchObject({ deferred: 0, unsent: 0 });
    expect(prints.has(OWN_TEXT)).toBe(true);
  });

  it("behält Ungesendetes nach einem Fehler und teilt große Mengen auf", async () => {
    const prints = new FakePrints();
    const reporter = new FingerprintReporter({ office, access: prints });
    // Drei Nachrichten mit je 1.800 verschiedenen Wörtern: 3 × 1.793 Fenster.
    for (let m = 0; m < 3; m++) {
      const words = Array.from({ length: 1_800 }, (_, i) => `m${String(m)}w${String(i)}`);
      office.sendMessage("ceo", { toId: COO, kind: "info", text: words.join(" ") });
    }
    const total = 3 * 1_793;

    prints.failNext = 1;
    const failed = await reporter.report();
    expect(failed.error).toBe("Verbindung abgebrochen");
    expect(failed.unsent).toBe(total);
    expect(reporter.pending).toBe(total);

    const ok = await reporter.report();
    expect(ok).toMatchObject({ sent: total, unsent: 0, error: null });
    expect(prints.received.map((r) => r.hashes.length)).toEqual([
      MAX_FINGERPRINTS_PER_CALL,
      total - MAX_FINGERPRINTS_PER_CALL,
    ]);
  });

  it("beantragt Werkbank-Läufe erst, wenn alles gemeldet ist", async () => {
    const prints = new FakePrints();
    const reporter = new FingerprintReporter({ office, access: prints });
    const requested: string[] = [];
    const inner: RunRequester = {
      requestRun(params) {
        requested.push(params.runType);
        return Promise.resolve({ decision: "admitted", runId: RUN_A });
      },
    };
    const requester = fingerprintsFirst(inner, reporter);
    const werkbank = {
      agentId: CTO,
      runType: "werkbank" as const,
      taskId: werkbankTask(),
      repo: REPO,
      model: "sonnet" as const,
      prompt: "x",
    };
    office.sendMessage("ceo", { toId: CTO, kind: "auftrag", text: CEO_TEXT });

    prints.failNext = 1;
    await expect(requester.requestRun(werkbank)).rejects.toThrow(/Werkbank-Lauf nicht beantragt/);
    expect(requested).toEqual([]);
    // Büro-Läufe übergeben nichts an Git und warten nicht auf die Meldung.
    expect(reporter.pending).toBeGreaterThan(0);
    await requester.requestRun({ ...werkbank, runType: "buero", taskId: null, repo: null });
    expect(requested).toEqual(["buero"]);

    await requester.requestRun(werkbank);
    expect(requested).toEqual(["buero", "werkbank"]);
    expect(prints.has(CEO_TEXT)).toBe(true);
  });
});
