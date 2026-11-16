/**
 * Ansichten des schlichten Webinterface (P10, plan.md Kap. 5.11, 7.2): Agentenliste, Kosten und
 * Kontingent, Zeitleiste, Chat und PR-Ansicht. Jede Funktion baut Elemente über `dom.js`; Texte
 * von Agenten und aus GitHub erscheinen nur als Text (AK 9).
 */

import { externalLink, h } from "./dom.js";
import {
  ciLabel,
  describeEvent,
  formatPercent,
  formatTime,
  formatUsd,
  githubPullUrl,
  kindLabel,
} from "./format.js";

/** Hinweis bei jeder PR-Ansicht (Kap. 5.11, E26). */
export const GITHUB_IS_BINDING =
  "Verbindlich ist die Ansicht in GitHub. Dieses Webinterface ist selbst veränderbarer Code, " +
  "seine Darstellung kann fehlerhaft sein. Freigeben kannst du nur in GitHub.";

/**
 * @typedef {import("./format.js").Lookup} Lookup
 * @typedef {import("./format.js").TimelineEvent} TimelineEvent
 */

/**
 * @typedef {object} AgentView
 * @property {string} id
 * @property {string} name
 * @property {string} role
 * @property {string | null} supervisorId
 * @property {string} roomId
 * @property {string | null} roomName
 * @property {boolean} running
 * @property {number} costUsd
 */

/**
 * @typedef {object} QuotaWindow
 * @property {string} label
 * @property {number} usedPercent
 * @property {number | null} pauseAtPercent
 * @property {string | null} resetsAt
 */

/**
 * @typedef {object} QuotaView
 * @property {string} measuredAt
 * @property {boolean} paused
 * @property {string | null} note
 * @property {QuotaWindow[]} windows
 */

/**
 * @typedef {object} OfficeStateView
 * @property {number} lastSeq
 * @property {string | null} cooId
 * @property {boolean} ceoViaCooOnly
 * @property {AgentView[]} agents
 * @property {{ id: string, title: string, status: string, assigneeId: string | null }[]} openTasks
 * @property {{ totalUsd: number, runs: number }} costs
 * @property {QuotaView | null} quota
 * @property {string | null} consoleUrl
 */

/**
 * @typedef {object} ChatMessage
 * @property {string} id
 * @property {number} seq
 * @property {string} occurredAt
 * @property {string} fromId
 * @property {string} toId
 * @property {string} kind
 * @property {string} text
 */

/**
 * @typedef {object} PullRequestView
 * @property {string} repo
 * @property {number} number
 * @property {string} title
 * @property {boolean} draft
 * @property {string} ci
 * @property {string} headSha
 * @property {string[]} agentIds
 * @property {number | null} costUsd
 * @property {string} summary
 * @property {string[]} criticalPaths
 * @property {string} updatedAt
 */

/**
 * @param {Document} doc
 * @param {string} iso
 * @returns {HTMLElement}
 */
function time(doc, iso) {
  return h(doc, "time", { datetime: iso }, formatTime(iso));
}

/**
 * Agentenliste mit Rolle, Raum, Vorgesetztem, Zustand und Kosten.
 *
 * @param {Document} doc
 * @param {OfficeStateView} state
 * @param {Lookup} lookup
 * @returns {HTMLElement}
 */
export function renderAgents(doc, state, lookup) {
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
 *
 * @param {Document} doc
 * @param {OfficeStateView} state
 * @returns {HTMLElement}
 */
export function renderCosts(doc, state) {
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
      ? h(doc, "p", { class: "empty" }, "Kontingent: noch keine Messung vom Supervisor.")
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
 *
 * @param {Document} doc
 * @param {TimelineEvent} event
 * @param {Lookup} lookup
 * @returns {HTMLElement}
 */
export function renderTimelineItem(doc, event, lookup) {
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
 *
 * @param {Document} doc
 * @param {ChatMessage} message
 * @param {Lookup} lookup
 * @returns {HTMLElement}
 */
export function renderChatMessage(doc, message, lookup) {
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

/**
 * PR-Ansicht (Kap. 5.11, E26): Liste mit Status, CI, Agenten, Kosten, Zusammenfassung und
 * kritischen Pfaden. Der Hinweis auf GitHub steht immer dabei, auch ohne Daten.
 *
 * @param {Document} doc
 * @param {{ available: boolean, pullRequests: PullRequestView[] }} data
 * @param {Lookup} lookup
 * @returns {HTMLElement}
 */
export function renderPullRequests(doc, data, lookup) {
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
 *
 * @param {Document} doc
 * @param {string | null} url
 * @returns {HTMLElement | null}
 */
export function renderConsoleLink(doc, url) {
  return url === null ? null : externalLink(doc, url, "Supervisor-Konsole (Notaus)");
}
