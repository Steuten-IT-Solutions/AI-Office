/**
 * Ansichten des schlichten Webinterface (P10, plan.md Kap. 5.11, 7.2): Agentenliste, Kosten und
 * Kontingent, Zeitleiste, Chat und PR-Ansicht. Jede Funktion baut Elemente über `dom.ts`; Texte
 * von Agenten und aus GitHub erscheinen nur als Text (AK 9).
 */

import { externalLink, h } from "./dom.ts";
import {
  ciLabel,
  describeEvent,
  formatPercent,
  formatTime,
  formatUsd,
  githubPullUrl,
  kindLabel,
  type Lookup,
  type TimelineEvent,
} from "./format.ts";

/** Hinweis bei jeder PR-Ansicht (Kap. 5.11, E26). */
export const GITHUB_IS_BINDING =
  "Verbindlich ist die Ansicht in GitHub. Dieses Webinterface ist selbst veränderbarer Code, " +
  "seine Darstellung kann fehlerhaft sein. Freigeben kannst du nur in GitHub.";

/** Ein Agent aus `GET /api/state`. */
export interface AgentView {
  id: string;
  name: string;
  role: string;
  supervisorId: string | null;
  roomId: string;
  roomName: string | null;
  running: boolean;
  costUsd: number;
}

/** Wie `QuotaView` im Gateway (`src/gateway/views.ts`). */
export interface QuotaWindow {
  label: string;
  usedPercent: number;
  pauseAtPercent: number | null;
  resetsAt: string | null;
}

export interface QuotaView {
  measuredAt: string;
  paused: boolean;
  note: string | null;
  windows: QuotaWindow[];
}

/** Antwort von `GET /api/state`. */
export interface OfficeStateView {
  lastSeq: number;
  cooId: string | null;
  ceoViaCooOnly: boolean;
  agents: AgentView[];
  openTasks: { id: string; title: string; status: string; assigneeId: string | null }[];
  costs: { totalUsd: number; runs: number };
  quota: QuotaView | null;
  consoleUrl: string | null;
}

/** Eine Nachricht aus `GET /api/chat`. */
export interface ChatMessage {
  id: string;
  seq: number;
  occurredAt: string;
  fromId: string;
  toId: string;
  kind: string;
  text: string;
}

/** Wie `PullRequestView` im Gateway (`src/gateway/views.ts`). */
export interface PullRequestView {
  repo: string;
  number: number;
  title: string;
  draft: boolean;
  ci: string;
  headSha: string;
  agentIds: string[];
  costUsd: number | null;
  summary: string;
  criticalPaths: string[];
  updatedAt: string;
}

export interface PullRequestList {
  available: boolean;
  pullRequests: PullRequestView[];
}

function time(doc: Document, iso: string): HTMLElement {
  return h(doc, "time", { datetime: iso }, formatTime(iso));
}

/**
 * Agentenliste mit Rolle, Raum, Vorgesetztem, Zustand und Kosten.
 */
export function renderAgents(doc: Document, state: OfficeStateView, lookup: Lookup): HTMLElement {
  if (state.agents.length === 0) {
    return h(doc, "p", { class: "empty" }, "Noch keine Agenten.");
  }
  return h(
    doc,
    "ul",
    { class: "agents" },
    ...state.agents.map((agent) =>
      h(
        doc,
        "li",
        { "data-state": agent.running ? "running" : "idle" },
        h(doc, "strong", null, agent.name),
        agent.id === state.cooId ? " (COO)" : "",
        h(doc, "span", { class: "role" }, agent.role),
        h(
          doc,
          "span",
          { class: "meta" },
          agent.running ? "arbeitet" : "frei",
          " · ",
          agent.roomName ?? agent.roomId,
          agent.supervisorId === null
            ? ""
            : ` · berichtet an ${lookup.agentName(agent.supervisorId)}`,
          " · ",
          formatUsd(agent.costUsd),
        ),
      ),
    ),
  );
}

/**
 * Kosten aus dem Hauptbuch des Office und Kontingent vom Supervisor (Kap. 6).
 */
export function renderCosts(doc: Document, state: OfficeStateView): HTMLElement {
  const quota = state.quota;
  return h(
    doc,
    "div",
    null,
    h(
      doc,
      "p",
      null,
      "Gesamt: ",
      h(doc, "strong", null, formatUsd(state.costs.totalUsd)),
      ` in ${String(state.costs.runs)} ${state.costs.runs === 1 ? "Lauf" : "Läufen"}`,
    ),
    quota === null
      ? h(
          doc,
          "p",
          { class: "empty" },
          "Kontingent: hier noch nicht angebunden. Den Stand zeigen die Supervisor-Konsole und „aioffice status“ (E67).",
        )
      : h(
          doc,
          "div",
          { class: "quota", "data-state": quota.paused ? "paused" : "ok" },
          h(
            doc,
            "p",
            null,
            quota.paused ? "Büro pausiert wegen des Kontingents. " : "",
            "Gemessen: ",
            time(doc, quota.measuredAt),
          ),
          h(
            doc,
            "ul",
            null,
            ...quota.windows.map((w) =>
              h(
                doc,
                "li",
                {
                  "data-state":
                    w.pauseAtPercent !== null && w.usedPercent >= w.pauseAtPercent ? "over" : "ok",
                },
                `${w.label}: ${formatPercent(w.usedPercent)}`,
                w.pauseAtPercent === null ? "" : ` (Pause ab ${formatPercent(w.pauseAtPercent)})`,
                w.resetsAt === null ? "" : " · Reset ",
                w.resetsAt === null ? null : time(doc, w.resetsAt),
              ),
            ),
          ),
          quota.note === null ? null : h(doc, "p", { class: "note" }, quota.note),
        ),
  );
}

/**
 * Eintrag der Zeitleiste: Zeitpunkt, Agent, Handlung, Kosten des Laufs (AK 11).
 */
export function renderTimelineItem(
  doc: Document,
  event: TimelineEvent,
  lookup: Lookup,
): HTMLElement {
  const described = describeEvent(event, lookup);
  return h(
    doc,
    "li",
    { "data-kind": described.level },
    time(doc, event.occurredAt),
    " ",
    h(doc, "strong", null, lookup.agentName(described.agentId)),
    " ",
    described.text,
    event.runId === null
      ? null
      : h(
          doc,
          "span",
          { class: "cost" },
          event.runCostUsd === null ? " · Lauf läuft" : ` · Lauf ${formatUsd(event.runCostUsd)}`,
        ),
  );
}

/**
 * Nachricht im Chat. Der Text bleibt vollständig und unverändert, nur als Text.
 */
export function renderChatMessage(
  doc: Document,
  message: ChatMessage,
  lookup: Lookup,
): HTMLElement {
  const own = message.fromId === "ceo";
  return h(
    doc,
    "li",
    { class: own ? "own" : "other", "data-kind": message.kind },
    h(
      doc,
      "div",
      { class: "meta" },
      h(doc, "strong", null, lookup.agentName(message.fromId)),
      ` an ${lookup.agentName(message.toId)} · ${kindLabel(message.kind)} · `,
      time(doc, message.occurredAt),
    ),
    h(doc, "div", { class: "text" }, message.text),
  );
}

/** Eine Weisung aus `GET /api/directives` (Kap. 4.4, E68). */
export interface DirectiveView {
  id: string;
  text: string;
  agentIds: string[] | null;
  occurredAt: string;
  revokedAt: string | null;
}

/**
 * Weisung des CEO mit Empfängern und Zeit. Eine geltende hat einen Knopf zum Zurücknehmen; der
 * Aufrufer hängt die Aktion an. Der Text erscheint nur als Text (AK 9).
 */
export function renderDirective(
  doc: Document,
  directive: DirectiveView,
  lookup: Lookup,
  onRevoke: (id: string) => void,
): HTMLElement {
  const targets =
    directive.agentIds === null
      ? "alle Agenten"
      : directive.agentIds.map((id) => lookup.agentName(id)).join(", ");
  const revoked = directive.revokedAt !== null;
  const meta = h(
    doc,
    "div",
    { class: "meta" },
    `Für ${targets} · seit `,
    time(doc, directive.occurredAt),
  );
  if (revoked) {
    meta.append(doc.createTextNode(" · zurückgenommen "), time(doc, directive.revokedAt as string));
  } else {
    const button = h(doc, "button", { class: "small" }, "Zurücknehmen");
    button.type = "button";
    button.addEventListener("click", () => {
      onRevoke(directive.id);
    });
    meta.append(doc.createTextNode(" · "), button);
  }
  return h(
    doc,
    "li",
    { class: revoked ? "revoked" : "active", "data-state": revoked ? "revoked" : "active" },
    meta,
    h(doc, "div", { class: "text" }, directive.text),
  );
}

/**
 * PR-Ansicht (Kap. 5.11, E26): Liste mit Status, CI, Agenten, Kosten, Zusammenfassung und
 * kritischen Pfaden. Der Hinweis auf GitHub steht immer dabei, auch ohne Daten.
 */
export function renderPullRequests(
  doc: Document,
  data: PullRequestList,
  lookup: Lookup,
): HTMLElement {
  const hint = h(doc, "p", { class: "hint", role: "note" }, GITHUB_IS_BINDING);
  if (!data.available) {
    return h(
      doc,
      "div",
      null,
      hint,
      h(doc, "p", { class: "empty" }, "PR-Daten vom Supervisor sind noch nicht angebunden."),
    );
  }
  if (data.pullRequests.length === 0) {
    return h(doc, "div", null, hint, h(doc, "p", { class: "empty" }, "Keine offenen PRs."));
  }
  return h(
    doc,
    "div",
    null,
    hint,
    h(
      doc,
      "ul",
      { class: "prs" },
      ...data.pullRequests.map((pr) =>
        h(
          doc,
          "li",
          { "data-state": pr.ci },
          h(
            doc,
            "div",
            null,
            h(doc, "strong", null, `${pr.repo} #${String(pr.number)}`),
            " ",
            pr.title,
            pr.draft ? " (Entwurf)" : "",
          ),
          h(
            doc,
            "div",
            { class: "meta" },
            ciLabel(pr.ci),
            ` · Head ${pr.headSha.slice(0, 7)}`,
            pr.agentIds.length === 0
              ? ""
              : ` · ${pr.agentIds.map((id) => lookup.agentName(id)).join(", ")}`,
            pr.costUsd === null ? "" : ` · ${formatUsd(pr.costUsd)}`,
            " · aktualisiert ",
            time(doc, pr.updatedAt),
          ),
          pr.summary === "" ? null : h(doc, "p", { class: "summary" }, pr.summary),
          pr.criticalPaths.length === 0
            ? null
            : h(
                doc,
                "div",
                { class: "critical" },
                "Kritische Pfade: ",
                h(doc, "ul", null, ...pr.criticalPaths.map((path) => h(doc, "li", null, path))),
              ),
          externalLink(doc, githubPullUrl(pr.repo, pr.number), "In GitHub prüfen und freigeben", {
            class: "button",
          }),
        ),
      ),
    ),
  );
}

/**
 * Link zur Supervisor-Konsole (Kap. 5.11). Notaus und Freigaben liegen dort, nicht hier (E26).
 */
export function renderConsoleLink(doc: Document, url: string | null): HTMLElement | null {
  return url === null ? null : externalLink(doc, url, "Supervisor-Konsole (Notaus)");
}
