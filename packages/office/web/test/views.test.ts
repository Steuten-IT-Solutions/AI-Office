import { describe, expect, it } from "vitest";
import { externalLink, h, replace, safeHttpsUrl } from "../src/dom.ts";
import {
  describeEvent,
  field,
  formatUsd,
  githubPullUrl,
  shorten,
  type Lookup,
  type TimelineEvent,
} from "../src/format.ts";
import {
  GITHUB_IS_BINDING,
  renderAgents,
  renderChatMessage,
  renderConsoleLink,
  renderCosts,
  renderDirective,
  renderPullRequests,
  renderTimelineItem,
  type OfficeStateView,
  type PullRequestView,
} from "../src/views.ts";
import { FakeDocument, FakeText, fake } from "./fake-dom.ts";

/** Typische Angriffe aus Agententext, Fremdtext und Namen (AK 9). */
const HOSTILE = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  '"><svg onload=alert(1)>',
  "javascript:alert(1)",
  "</li><li>gefälscht</li>",
  "&lt;b&gt;fett&lt;/b&gt;",
  "‮egnaro",
].join(" ");

const lookup: Lookup = {
  agentName: (id) => ({ ceo: "CEO", "deniz-kaya": HOSTILE })[id] ?? id,
  taskTitle: (id) => (id === "t-1" ? HOSTILE : null),
};

function event(type: string, payload: unknown, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    seq: 1,
    id: "e-1",
    type,
    version: 1,
    actor: "deniz-kaya",
    runId: null,
    occurredAt: "2026-11-16T10:00:00Z",
    payload,
    runCostUsd: null,
    ...extra,
  };
}

const STATE: OfficeStateView = {
  lastSeq: 5,
  cooId: "deniz-kaya",
  ceoViaCooOnly: false,
  agents: [
    {
      id: "deniz-kaya",
      name: HOSTILE,
      role: HOSTILE,
      supervisorId: null,
      roomId: "buero-1",
      roomName: HOSTILE,
      running: true,
      costUsd: 0.1234,
    },
  ],
  openTasks: [],
  costs: { totalUsd: 1.5, runs: 2 },
  quota: {
    measuredAt: "2026-11-16T10:00:00Z",
    paused: false,
    note: HOSTILE,
    windows: [{ label: HOSTILE, usedPercent: 56, pauseAtPercent: 55, resetsAt: null }],
  },
  consoleUrl: "https://konsole.aio-sup.internal/",
};

const PR: PullRequestView = {
  repo: "Steuten-IT-Solutions/AI-Office",
  number: 42,
  title: HOSTILE,
  draft: false,
  ci: "success",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  agentIds: ["deniz-kaya"],
  costUsd: 0.5,
  summary: HOSTILE,
  criticalPaths: [HOSTILE, "package.json"],
  updatedAt: "2026-11-16T10:00:00Z",
};

/** Kein Markup aus Text: nur die Tags, die die Ansicht selbst baut, keine gefährlichen Attribute. */
function expectOnlyText(doc: FakeDocument): void {
  const allowed = new Set(["div", "p", "span", "strong", "ul", "li", "time", "a"]);
  expect(doc.created.filter((tag) => !allowed.has(tag))).toEqual([]);
  for (const [name, value] of doc.attributeLog) {
    expect(name).not.toMatch(/^on|^style$|^href$|^src$/i);
    expect(value).not.toContain("<");
  }
}

describe("dom.js", () => {
  it("macht aus Zeichenketten nur Textknoten", () => {
    const doc = new FakeDocument();
    const el = fake(h(doc.asDocument, "p", null, HOSTILE, 3, null, false, undefined));
    expect(el.children).toHaveLength(2);
    expect(el.children[0]).toBeInstanceOf(FakeText);
    expect(el.textContent).toBe(`${HOSTILE}3`);
    expect(doc.created).toEqual(["p"]);
  });

  it("erlaubt nur Attribute aus der festen Liste", () => {
    const doc = new FakeDocument().asDocument;
    for (const name of ["onclick", "onerror", "style", "href", "src", "srcdoc", "formaction"]) {
      expect(() => h(doc, "div", { [name]: "x" })).toThrow(/nicht erlaubt/);
    }
    expect(() => h(doc, "div", { class: "a", "data-kind": "b" })).not.toThrow();
  });

  it("ersetzt den Inhalt", () => {
    const doc = new FakeDocument();
    const el = fake(h(doc.asDocument, "div", null, "alt"));
    replace(doc.asDocument, el as unknown as Element, "neu");
    expect(el.textContent).toBe("neu");
  });

  it("Links nur zu https ohne Zugangsdaten, sonst nur Text", () => {
    expect(safeHttpsUrl("https://github.com/a/b/pull/1")).toBe("https://github.com/a/b/pull/1");
    for (const bad of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://github.com/",
      "https://nutzer:pw@github.com/",
      "//evil.example/",
      "/relativ",
      42,
      null,
    ]) {
      expect([bad, safeHttpsUrl(bad)]).toEqual([bad, null]);
    }
    const doc = new FakeDocument();
    const link = fake(externalLink(doc.asDocument, "https://github.com/a/b", HOSTILE));
    expect(link.tagName).toBe("a");
    expect([link.href, link.target, link.rel]).toEqual([
      "https://github.com/a/b",
      "_blank",
      "noopener noreferrer",
    ]);
    expect(link.textContent).toBe(HOSTILE);
    const span = fake(externalLink(doc.asDocument, "javascript:alert(1)", "x"));
    expect([span.tagName, span.href]).toEqual(["span", ""]);
  });
});

describe("format.js", () => {
  it("liest Payloads defensiv", () => {
    expect(field(null, "a")).toBe("");
    expect(field([], "a")).toBe("");
    expect(field({ a: 1 }, "a")).toBe("");
    expect(field({ a: "x" }, "a")).toBe("x");
    for (const payload of [null, 5, "text", [], { text: { nested: true } }]) {
      for (const type of ["message.sent", "agent.hired", "run.finished", "task.status_changed"]) {
        expect(() => describeEvent(event(type, payload), lookup)).not.toThrow();
      }
    }
  });

  it("beschreibt jede Art von Ereignis mit dem handelnden Agenten", () => {
    const cases: [TimelineEvent, string, string][] = [
      [
        event("message.sent", { toId: "ceo", kind: "frage", text: "Wie weiter?" }),
        "deniz-kaya",
        "Frage an CEO: Wie weiter?",
      ],
      [
        event("task.created", { title: "Bau", assigneeId: "ceo" }),
        "deniz-kaya",
        "legt Aufgabe „Bau“ an, zugewiesen an CEO",
      ],
      [
        event("task.status_changed", { taskId: "t-2", status: "in_arbeit", note: null }),
        "deniz-kaya",
        "setzt einer Aufgabe auf in Arbeit",
      ],
      [
        event(
          "run.started",
          { agentId: "jonas", runType: "buero", model: "sonnet" },
          {
            actor: "system",
          },
        ),
        "jonas",
        "Lauf beginnt (buero, sonnet)",
      ],
      [
        event("run.finished", { exit: "completed", numTurns: 3, model: "claude-x" }),
        "deniz-kaya",
        "Lauf endet abgeschlossen, 3 Runden, Modell claude-x",
      ],
      [
        event("gibt.es.nicht", {}, { version: 7 }),
        "deniz-kaya",
        "Ereignis gibt.es.nicht (Version 7)",
      ],
    ];
    for (const [e, agentId, text] of cases) {
      expect(describeEvent(e, lookup)).toMatchObject({ agentId, text });
    }
    expect(
      describeEvent(event("escalation.raised", { toId: "ceo", text: "x" }), lookup).level,
    ).toBe("wichtig");
  });

  it("kürzt lange Texte nach Zeichen, nicht nach UTF-16-Einheiten", () => {
    expect(shorten("abc", 3)).toBe("abc");
    expect(shorten("abcd", 3)).toBe("ab…");
    expect(shorten("😀😀😀😀", 3)).toBe("😀😀…");
  });

  it("formatiert Kosten in USD", () => {
    expect(formatUsd(0.1234)).toBe("0,1234\u00a0$");
    expect(formatUsd(12.5)).toBe("12,50\u00a0$");
  });

  it("baut den GitHub-Link nur aus gültigem Repo und Nummer", () => {
    expect(githubPullUrl("Steuten-IT-Solutions/AI-Office", 7)).toBe(
      "https://github.com/Steuten-IT-Solutions/AI-Office/pull/7",
    );
    for (const [repo, number] of [
      ["evil.example/../x", 1],
      ["a/b/c", 1],
      ["a/b?x=1", 1],
      ["a/b#x", 1],
      ["@evil.example/x", 1],
      ["a/b", 0],
      ["a/b", 1.5],
      ["a/b", "1"],
      [null, 1],
    ] as const) {
      expect([repo, number, githubPullUrl(repo, number)]).toEqual([repo, number, null]);
    }
  });
});

describe("Ansichten (AK 9: Agententext nur als Text)", () => {
  it("Agentenliste", () => {
    const doc = new FakeDocument();
    const el = fake(renderAgents(doc.asDocument, STATE, lookup));
    expect(el.textContent).toContain(HOSTILE);
    expect(el.textContent).toContain("arbeitet");
    expectOnlyText(doc);
  });

  it("Weisung mit Empfängern, Zeit und Knopf zum Zurücknehmen (E68)", () => {
    const doc = new FakeDocument();
    const revoked: string[] = [];
    const directive = {
      id: "w-1",
      text: HOSTILE,
      agentIds: ["deniz-kaya", "jonas-albrecht"],
      occurredAt: "2026-11-25T20:00:00Z",
      revokedAt: null,
    };
    const el = fake(
      renderDirective(doc.asDocument, directive, lookup, (id) => {
        revoked.push(id);
      }),
    );
    expect(el.getAttribute("data-state")).toBe("active");
    expect(el.textContent).toContain(`Für ${HOSTILE}, jonas-albrecht · seit `);
    expect(el.findAll("div")[1]?.textContent).toBe(HOSTILE);
    const button = el.findAll("button")[0];
    expect(button?.textContent).toBe("Zurücknehmen");
    expect(button?.type).toBe("button");
    button?.click();
    expect(revoked).toEqual(["w-1"]);
    // Nur Text und ein Knopf, kein Markup aus dem Text der Weisung.
    expect(doc.created.filter((tag) => !["div", "li", "time", "button"].includes(tag))).toEqual([]);
    for (const [name, value] of doc.attributeLog) {
      expect(name).not.toMatch(/^on|^style$|^href$|^src$/i);
      expect(value).not.toContain("<");
    }

    const old = fake(
      renderDirective(
        new FakeDocument().asDocument,
        { ...directive, agentIds: null, revokedAt: "2026-11-25T21:00:00Z" },
        lookup,
        () => undefined,
      ),
    );
    expect(old.getAttribute("data-state")).toBe("revoked");
    expect(old.textContent).toContain("Für alle Agenten · seit ");
    expect(old.textContent).toContain(" · zurückgenommen ");
    expect(old.findAll("button")).toEqual([]);
  });

  it("Kosten und Kontingent", () => {
    const doc = new FakeDocument();
    const el = fake(renderCosts(doc.asDocument, STATE));
    expect(el.textContent).toContain("1,50\u00a0$");
    expect(el.textContent).toContain("2 Läufen");
    expect(el.textContent).toContain("56 % (Pause ab 55 %)");
    expect(el.findAll("li")[0]?.getAttribute("data-state")).toBe("over");
    expect(el.textContent).toContain(HOSTILE);
    expectOnlyText(doc);
    const none = fake(renderCosts(new FakeDocument().asDocument, { ...STATE, quota: null }));
    expect(none.textContent).toContain("noch nicht angebunden");
  });

  it("Zeitleiste mit Agent, Zeitpunkt und Kosten des Laufs (AK 11)", () => {
    const doc = new FakeDocument();
    const el = fake(
      renderTimelineItem(
        doc.asDocument,
        event(
          "message.sent",
          { toId: "ceo", kind: "info", text: HOSTILE },
          {
            runId: "run-1",
            runCostUsd: 0.25,
          },
        ),
        lookup,
      ),
    );
    expect(el.findAll("time")[0]?.getAttribute("datetime")).toBe("2026-11-16T10:00:00Z");
    expect(el.findAll("strong")[0]?.textContent).toBe(HOSTILE);
    expect(el.textContent).toContain("Lauf 0,25\u00a0$");
    expectOnlyText(doc);
    const running = fake(
      renderTimelineItem(
        new FakeDocument().asDocument,
        event("run.thought", { text: "hm" }, { runId: "run-2" }),
        lookup,
      ),
    );
    expect(running.textContent).toContain("Lauf läuft");
  });

  it("Zeitleiste: jeder Ereignistyp mit feindlichem Payload bleibt Text", () => {
    const types = [
      "agent.hired",
      "agent.profile_changed",
      "task.created",
      "task.delegated",
      "task.status_changed",
      "task.handover",
      "message.sent",
      "escalation.raised",
      "escalation.answered",
      "run.thought",
      "run.started",
      "run.finished",
      HOSTILE,
    ];
    const payload = {
      profile: { name: HOSTILE, role: HOSTILE },
      title: HOSTILE,
      taskId: "t-1",
      assigneeId: HOSTILE,
      status: HOSTILE,
      note: HOSTILE,
      toId: HOSTILE,
      kind: HOSTILE,
      text: HOSTILE,
      agentId: HOSTILE,
      runType: HOSTILE,
      model: HOSTILE,
      exit: HOSTILE,
    };
    for (const type of types) {
      const doc = new FakeDocument();
      renderTimelineItem(doc.asDocument, event(type, payload, { actor: HOSTILE }), lookup);
      expectOnlyText(doc);
    }
  });

  it("Chat zeigt den vollen Text unverändert", () => {
    const doc = new FakeDocument();
    const text = `${HOSTILE}\n${"x".repeat(5000)}`;
    const el = fake(
      renderChatMessage(
        doc.asDocument,
        {
          id: "m-1",
          seq: 3,
          occurredAt: "2026-11-16T10:00:00Z",
          fromId: "deniz-kaya",
          toId: "ceo",
          kind: "frage",
          text,
        },
        lookup,
      ),
    );
    expect(el.findAll("div")[1]?.textContent).toBe(text);
    expect(el.getAttribute("class")).toBe("other");
    expectOnlyText(doc);
  });

  it("PR-Ansicht: Hinweis auf GitHub immer, Link nur nach GitHub, kritische Pfade sichtbar", () => {
    for (const data of [
      { available: false, pullRequests: [] },
      { available: true, pullRequests: [] },
      { available: true, pullRequests: [PR] },
    ]) {
      const doc = new FakeDocument();
      const el = fake(renderPullRequests(doc.asDocument, data, lookup));
      expect(el.findAll("p")[0]?.textContent).toBe(GITHUB_IS_BINDING);
      expectOnlyText(doc);
    }
    const doc = new FakeDocument();
    const el = fake(
      renderPullRequests(doc.asDocument, { available: true, pullRequests: [PR] }, lookup),
    );
    const links = el.findAll("a");
    expect(links.map((a) => [a.href, a.textContent])).toEqual([
      [
        "https://github.com/Steuten-IT-Solutions/AI-Office/pull/42",
        "In GitHub prüfen und freigeben",
      ],
    ]);
    expect(el.findAll("div").find((d) => d.getAttribute("class") === "critical")?.textContent).toBe(
      `Kritische Pfade: ${HOSTILE}package.json`,
    );
    expect(el.textContent).toContain("CI grün");
    expect(el.textContent).toContain("Head 0123456");
    // Ein Repo, das nicht nach GitHub-Regeln aussieht, bekommt keinen Link.
    const bad = fake(
      renderPullRequests(
        new FakeDocument().asDocument,
        { available: true, pullRequests: [{ ...PR, repo: "evil.example/../../x" }] },
        lookup,
      ),
    );
    expect(bad.findAll("a")).toEqual([]);
  });

  it("Link zur Konsole nur mit https", () => {
    const doc = new FakeDocument().asDocument;
    expect(renderConsoleLink(doc, null)).toBeNull();
    expect(fake(renderConsoleLink(doc, "https://konsole.aio-sup.internal/")).tagName).toBe("a");
    expect(fake(renderConsoleLink(doc, "javascript:alert(1)")).tagName).toBe("span");
  });
});
