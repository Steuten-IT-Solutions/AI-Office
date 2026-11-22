import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord, RunStart } from "./domain/office-state.ts";
import type { HeadReport } from "./events/head-reporter.ts";
import type { FingerprintReport } from "./git/fingerprints.ts";
import type { ProfileSyncResult } from "./ipc/profile-sync.ts";
import type { MergeFollowResult } from "./git/merge-follower.ts";
import type { GitOutcomeResult } from "./git/outcome-follower.ts";
import type { LogFields, Logger } from "./log.ts";
import type { Plan, TickResult } from "./planner/planner.ts";
import type { CheckRunStep } from "./runs/check-run.ts";
import type { FollowResult } from "./runs/run-follower.ts";
import {
  DEFAULT_TAKT_INTERVALS,
  OfficeTakt,
  TAKT_JOBS,
  type TaktJob,
  type TaktParts,
} from "./takt.ts";

const EMPTY_PLAN: Plan = {
  wakes: [],
  holds: [],
  notices: [],
  forwards: [],
  blocked: [],
  nextCheckAt: null,
};

const tick = (extra: Partial<TickResult> = {}): TickResult => ({
  started: [],
  rejected: [],
  failed: [],
  notices: 0,
  forwards: 0,
  errors: [],
  plan: EMPTY_PLAN,
  ...extra,
});
const follow = (extra: Partial<FollowResult> = {}): FollowResult => ({
  registered: [],
  finished: [],
  failed: [],
  ...extra,
});
const outcomes = (extra: Partial<GitOutcomeResult> = {}): GitOutcomeResult => ({
  recorded: [],
  pending: [],
  failed: [],
  unavailable: false,
  ...extra,
});
const merges = (extra: Partial<MergeFollowResult> = {}): MergeFollowResult => ({
  recorded: [],
  open: [],
  failed: [],
  unavailable: false,
  ...extra,
});
const fingerprintReport = (extra: Partial<FingerprintReport> = {}): FingerprintReport => ({
  sent: 0,
  added: 0,
  unsent: 0,
  deferred: 0,
  error: null,
  ...extra,
});
const headReport = (): HeadReport => ({ reported: null, auditSeq: null });
const checkStep = (extra: Partial<CheckRunStep> = {}): CheckRunStep => ({
  started: null,
  reported: null,
  rejected: null,
  unavailable: false,
  ...extra,
});

const START = { runId: "r-0000000000000001", agentId: "deniz-kaya" } as RunStart;
const RECORD = {
  runId: "r-0000000000000001",
  agentId: "deniz-kaya",
  exit: "completed",
} as RunRecord;

interface Recorded {
  level: string;
  message: string;
  fields: LogFields;
}

let calls: TaktJob[];
let logs: Recorded[];
let results: {
  profiles: () => Promise<ProfileSyncResult>;
  planner: () => Promise<TickResult>;
  runs: () => Promise<FollowResult>;
  gitOutcomes: () => Promise<GitOutcomeResult>;
  merges: () => Promise<MergeFollowResult>;
  fingerprints: () => Promise<FingerprintReport>;
  head: () => Promise<HeadReport>;
  checkRuns: () => Promise<CheckRunStep>;
  checkRunPoll: () => Promise<CheckRunStep>;
};
let pruned: Date[];
let takt: OfficeTakt | undefined;

function logger(): Logger {
  const entry =
    (level: string) =>
    (message: string, fields: LogFields = {}) => {
      logs.push({ level, message, fields });
    };
  return { debug: entry("debug"), info: entry("info"), warn: entry("warn"), error: entry("error") };
}

function parts(): TaktParts {
  const track =
    <T>(job: TaktJob, fn: () => () => Promise<T>) =>
    () => {
      calls.push(job);
      return fn()();
    };
  return {
    profiles: { sync: track("profiles", () => results.profiles) },
    planner: { tick: track("planner", () => results.planner) },
    runs: { poll: track("runs", () => results.runs) },
    gitOutcomes: { poll: track("gitOutcomes", () => results.gitOutcomes) },
    merges: { poll: track("merges", () => results.merges) },
    fingerprints: { report: track("fingerprints", () => results.fingerprints) },
    head: { report: track("head", () => results.head) },
    // `poll` läuft im Takt `runs` mit und zählt nicht als eigener Teil.
    checkRuns: {
      fetch: track("checkRuns", () => results.checkRuns),
      poll: () => results.checkRunPoll(),
    },
    tokens: {
      prune(now) {
        pruned.push(now ?? new Date(0));
      },
    },
  };
}

function create(): OfficeTakt {
  takt = new OfficeTakt({
    parts: parts(),
    log: logger(),
    now: () => new Date("2026-11-22T12:00:00Z"),
  });
  return takt;
}

const count = (job: TaktJob) => calls.filter((c) => c === job).length;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  logs = [];
  pruned = [];
  results = {
    profiles: () => Promise.resolve({ approved: [], rejected: [], failed: [] }),
    planner: () => Promise.resolve(tick()),
    runs: () => Promise.resolve(follow()),
    gitOutcomes: () => Promise.resolve(outcomes()),
    merges: () => Promise.resolve(merges()),
    fingerprints: () => Promise.resolve(fingerprintReport()),
    head: () => Promise.resolve(headReport()),
    checkRuns: () => Promise.resolve(checkStep()),
    checkRunPoll: () => Promise.resolve(checkStep()),
  };
});

afterEach(async () => {
  await takt?.stop();
  takt = undefined;
  vi.useRealTimers();
});

describe("OfficeTakt", () => {
  it("startet jeden Teil sofort und wiederholt ihn im eigenen Abstand", async () => {
    const t = create();
    t.start();
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    expect([...calls].sort()).toEqual([...TAKT_JOBS].sort());
    expect(pruned).toEqual([new Date("2026-11-22T12:00:00Z")]);

    calls = [];
    await vi.advanceTimersByTimeAsync(DEFAULT_TAKT_INTERVALS.runs);
    expect(calls).toEqual(["runs"]);
    await vi.advanceTimersByTimeAsync(DEFAULT_TAKT_INTERVALS.planner - DEFAULT_TAKT_INTERVALS.runs);
    expect(count("planner")).toBe(1);
    expect(count("runs")).toBe(5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count("merges")).toBe(1);
    expect(count("head")).toBe(1);
  });

  it("lässt einen Teil nie zweimal gleichzeitig laufen und holt einen Anstoß danach nach", async () => {
    let release: () => void = () => undefined;
    results.planner = () =>
      new Promise((resolve) => {
        release = () => {
          resolve(tick());
        };
      });
    const t = create();
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.isRunning("planner")).toBe(true);
    t.kick("planner");
    t.kick("planner");
    await vi.advanceTimersByTimeAsync(DEFAULT_TAKT_INTERVALS.planner * 3);
    expect(count("planner")).toBe(1);

    results.planner = () => Promise.resolve(tick());
    release();
    await vi.advanceTimersByTimeAsync(0);
    // Die zwei Anstöße während des Durchlaufs ergeben genau einen weiteren Durchlauf.
    expect(count("planner")).toBe(2);
    await vi.advanceTimersByTimeAsync(DEFAULT_TAKT_INTERVALS.planner - 1);
    expect(count("planner")).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(count("planner")).toBe(3);
  });

  it("holt nach einem zugelassenen Lauf sofort das Token ab", async () => {
    const t = create();
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    calls = [];
    results.planner = () => Promise.resolve(tick({ started: [START] }));
    t.kick("planner");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["planner", "runs"]);
    expect(logs.find((l) => l.message === "Lauf zugelassen")?.fields).toMatchObject({
      runId: START.runId,
    });
  });

  it("begleitet einen angeforderten Prüflauf sofort im Takt der Läufe (S11b)", async () => {
    const t = create();
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    calls = [];
    let polls = 0;
    results.checkRunPoll = () => {
      polls += 1;
      return Promise.resolve(
        checkStep(
          polls === 2
            ? { reported: { runId: START.runId, exit: "completed", recorded: true } }
            : {},
        ),
      );
    };
    results.checkRuns = () => Promise.resolve(checkStep({ started: START.runId }));
    t.kick("checkRuns");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["checkRuns", "runs"]);
    expect(logs.map((l) => l.message)).toContain("Prüflauf angefordert");
    await vi.advanceTimersByTimeAsync(DEFAULT_TAKT_INTERVALS.runs);
    expect(logs.find((l) => l.message === "Prüflauf gemeldet")?.fields).toMatchObject({
      runId: START.runId,
      exit: "completed",
    });

    // Ein Fehler beim Prüflauf hält die Läufe der Agenten nicht auf.
    calls = [];
    results.checkRunPoll = () => Promise.reject(new Error("Socket weg"));
    results.checkRuns = () => Promise.resolve(checkStep({ rejected: "Notaus (pause) ist aktiv" }));
    t.kick("runs");
    t.kick("checkRuns");
    await vi.advanceTimersByTimeAsync(0);
    expect([...calls].sort()).toEqual(["checkRuns", "runs"]);
    const problems = logs.filter((l) => l.message === "Takt: Problem").map((l) => l.fields);
    expect(problems).toEqual(
      expect.arrayContaining([
        { job: "runs", problem: "Prüflauf: Socket weg" },
        { job: "checkRuns", problem: "Prüflauf abgelehnt: Notaus (pause) ist aktiv" },
      ]),
    );
  });

  it("stößt nach einem beendeten Lauf Planer, Git-Gate und Fingerabdrücke an", async () => {
    const t = create();
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    calls = [];
    results.runs = () =>
      Promise.resolve(
        follow({
          finished: [
            {
              run: RECORD,
              end: { reason: "beendet", exitCode: 0, finishedBy: "normal", truncated: false },
            },
          ],
        }),
      );
    t.kick("runs");
    await vi.advanceTimersByTimeAsync(0);
    expect([...calls].sort()).toEqual(["fingerprints", "gitOutcomes", "planner", "runs"]);
    expect(logs.find((l) => l.message === "Lauf abgeschlossen")?.fields).toMatchObject({
      runId: RECORD.runId,
      exit: "completed",
      reason: "beendet",
    });
  });

  it("fragt nach einem geöffneten PR sofort den Merge-Stand ab", async () => {
    const t = create();
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    calls = [];
    results.gitOutcomes = () =>
      Promise.resolve(
        outcomes({
          recorded: [
            {
              runId: RECORD.runId,
              state: "pr_opened",
              pr: 7,
            } as GitOutcomeResult["recorded"][number],
          ],
        }),
      );
    t.kick("gitOutcomes");
    await vi.advanceTimersByTimeAsync(0);
    expect([...calls].sort()).toEqual(["fingerprints", "gitOutcomes", "merges"]);

    calls = [];
    results.gitOutcomes = () =>
      Promise.resolve(
        outcomes({
          recorded: [
            {
              runId: RECORD.runId,
              state: "rejected",
              pr: null,
            } as GitOutcomeResult["recorded"][number],
          ],
        }),
      );
    t.kick("gitOutcomes");
    await vi.advanceTimersByTimeAsync(0);
    expect([...calls].sort()).toEqual(["fingerprints", "gitOutcomes"]);
  });

  it("meldet ein Problem einmal, eine Änderung erneut und das Ende des Problems", async () => {
    results.runs = () => Promise.reject(new Error("Socket weg"));
    results.gitOutcomes = () => Promise.resolve(outcomes({ unavailable: true }));
    const t = create();
    t.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_TAKT_INTERVALS.runs * 3);
    expect(count("runs")).toBe(4);
    const warnings = () => logs.filter((l) => l.level === "warn");
    expect(warnings()).toHaveLength(2);
    expect(warnings()).toEqual(
      expect.arrayContaining([
        { level: "warn", message: "Takt: Problem", fields: { job: "runs", problem: "Socket weg" } },
        {
          level: "warn",
          message: "Takt: Problem",
          fields: {
            job: "gitOutcomes",
            problem: "Der Supervisor hat kein Git-Gate (not_available)",
          },
        },
      ]),
    );

    results.runs = () =>
      Promise.resolve(follow({ failed: [{ runId: "r-1", error: "Zeit abgelaufen" }] }));
    await vi.advanceTimersByTimeAsync(DEFAULT_TAKT_INTERVALS.runs * 2);
    expect(warnings()).toHaveLength(3);
    expect(warnings()[2]?.fields).toEqual({ job: "runs", problem: "r-1: Zeit abgelaufen" });

    results.runs = () => Promise.resolve(follow());
    await vi.advanceTimersByTimeAsync(DEFAULT_TAKT_INTERVALS.runs * 2);
    expect(logs.filter((l) => l.message === "Takt: wieder ohne Problem")).toEqual([
      { level: "info", message: "Takt: wieder ohne Problem", fields: { job: "runs" } },
    ]);
  });

  it("sammelt Fehler aus Planer, Merge-Gate und Fingerabdrücken", async () => {
    results.planner = () =>
      Promise.resolve(
        tick({
          failed: [{ agentId: "deniz-kaya", error: "kaputt", outcomeUnknown: false }],
          errors: ["hinweis:1: voll"],
        }),
      );
    results.merges = () => Promise.resolve(merges({ unavailable: true }));
    results.fingerprints = () =>
      Promise.resolve(fingerprintReport({ unsent: 3, error: "Socket weg" }));
    const t = create();
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    const problems = Object.fromEntries(
      logs
        .filter((l) => l.level === "warn")
        .map((l): [string, unknown] => [String(l.fields["job"]), l.fields["problem"]]),
    );
    expect(problems).toEqual({
      planner: "deniz-kaya: kaputt; hinweis:1: voll",
      merges: "Der Supervisor hat kein Merge-Gate (not_available)",
      fingerprints: "3 Fingerabdrücke offen: Socket weg",
    });
  });

  it("wartet beim Beenden auf laufende Durchläufe und startet danach keinen mehr", async () => {
    let release: () => void = () => undefined;
    results.merges = () =>
      new Promise((resolve) => {
        release = () => {
          resolve(merges());
        };
      });
    const t = create();
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = t.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);

    calls = [];
    t.kick("planner");
    t.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toEqual([]);
  });

  it("startet den Planer erst nach dem ersten Abgleich der Profile, auch wenn er scheitert", async () => {
    let release: () => void = () => undefined;
    results.profiles = () =>
      new Promise((_resolve, reject) => {
        release = () => {
          reject(new Error("Socket weg"));
        };
      });
    const t = create();
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    t.kick("planner");
    await vi.advanceTimersByTimeAsync(DEFAULT_TAKT_INTERVALS.planner * 2);
    expect(count("planner")).toBe(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(count("planner")).toBe(1);
    expect(logs).toContainEqual({
      level: "warn",
      message: "Takt: Problem",
      fields: { job: "profiles", problem: "Socket weg" },
    });
  });

  it("meldet abgelehnte und zurückgestellte Profile als Problem", async () => {
    results.profiles = () =>
      Promise.resolve({
        approved: [{ kind: "raum", id: "buero-coo" }],
        rejected: [{ kind: "profil", id: "deniz-kaya", reason: "Modell nicht erlaubt" }],
        failed: [
          { kind: "profil", id: "lea-brandt", error: "Vorgesetzter deniz-kaya nicht freigegeben" },
        ],
      });
    const t = create();
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toContainEqual({
      level: "info",
      message: "Beim Supervisor freigegeben",
      fields: { kind: "raum", id: "buero-coo" },
    });
    expect(logs.find((l) => l.fields["job"] === "profiles")?.fields["problem"]).toBe(
      "profil deniz-kaya abgelehnt: Modell nicht erlaubt; " +
        "profil lea-brandt: Vorgesetzter deniz-kaya nicht freigegeben",
    );
  });

  it("nimmt Anstöße erst nach dem Start an und prüft die Abstände", async () => {
    const t = create();
    t.kick("planner");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
    expect(() => new OfficeTakt({ parts: parts(), log: logger(), intervals: { runs: 0 } })).toThrow(
      "Abstand für runs muss eine ganze Zahl ab 1 ms sein",
    );
  });
});
