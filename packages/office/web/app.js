/**
 * Einstieg des schlichten Webinterface (P10). Verbindet die Ansichten aus `views.js` mit dem
 * Gateway: Anmeldung, Zustand, Zeitleiste, Chat, PRs und Live-Hinweise per WebSocket.
 *
 * Über den WebSocket kommt nur „neue Ereignisse bis Sequenz N“. Die Daten holt dieser Code dann
 * über HTTP (P09). Texte gehen nur über `dom.js` ins DOM (AK 9).
 */

import { Api, ApiError } from "./api.js";
import { h, replace } from "./dom.js";
import {
  renderAgents,
  renderChatMessage,
  renderConsoleLink,
  renderCosts,
  renderPullRequests,
  renderTimelineItem,
} from "./views.js";

/**
 * @typedef {import("./views.js").OfficeStateView} OfficeStateView
 * @typedef {import("./views.js").ChatMessage} ChatMessage
 * @typedef {import("./views.js").PullRequestView} PullRequestView
 * @typedef {import("./format.js").TimelineEvent} TimelineEvent
 * @typedef {import("./format.js").Lookup} Lookup
 */

/** Einträge der Zeitleiste im DOM. Ältere fallen heraus. */
const MAX_TIMELINE_ITEMS = 500;
/** Wie viele Einträge beim ersten Aufbau geholt werden. */
const INITIAL_ITEMS = 200;
/** Seitengröße beim Nachladen, wie `MAX_TIMELINE_LIMIT` im Gateway. */
const PAGE = 500;
/** PRs ändern sich ohne Ereignis im Office; deshalb zusätzlich in diesem Abstand. */
const PR_REFRESH_MS = 60_000;
const MAX_RECONNECT_MS = 30_000;

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function byId(id) {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Element #${id} fehlt in index.html`);
  }
  return element;
}

const ui = {
  status: byId("status"),
  login: byId("login"),
  loginForm: /** @type {HTMLFormElement} */ (byId("login-form")),
  password: /** @type {HTMLInputElement} */ (byId("password")),
  loginError: byId("login-error"),
  app: byId("app"),
  logout: /** @type {HTMLButtonElement} */ (byId("logout")),
  consoleLink: byId("console-link"),
  agents: byId("agents"),
  costs: byId("costs"),
  prs: byId("prs"),
  timeline: byId("timeline"),
  chatForm: /** @type {HTMLFormElement} */ (byId("chat-form")),
  chatTo: /** @type {HTMLSelectElement} */ (byId("chat-to")),
  chatKind: /** @type {HTMLSelectElement} */ (byId("chat-kind")),
  chatText: /** @type {HTMLTextAreaElement} */ (byId("chat-text")),
  chatSend: /** @type {HTMLButtonElement} */ (byId("chat-send")),
  chatError: byId("chat-error"),
  chatLog: byId("chat-log"),
};

const api = new Api();

const session = {
  /** @type {OfficeStateView | null} */
  state: null,
  /** Höchste Sequenz in der Zeitleiste. */
  timelineSeq: 0,
  /** Gesprächspartner im Chat und höchste Sequenz seiner Nachrichten. */
  chatPartner: "",
  chatSeq: 0,
  /** Gemeldeter Stand vom WebSocket. */
  liveSeq: 0,
  /** @type {Map<string, string>} */
  taskTitles: new Map(),
  /** @type {WebSocket | null} */
  socket: null,
  reconnectMs: 1000,
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  reconnectTimer: undefined,
  /** @type {ReturnType<typeof setInterval> | undefined} */
  prTimer: undefined,
  refreshing: false,
  refreshAgain: false,
  /** Entwurf im Chat: dieselbe `clientId` bei einer Wiederholung (Idempotenz im Gateway). */
  draft: { text: "", to: "", kind: "", clientId: "" },
};

/** @type {Lookup} */
const lookup = {
  agentName(id) {
    if (id === "ceo") {
      return "CEO";
    }
    if (id === "system") {
      return "System";
    }
    return session.state?.agents.find((a) => a.id === id)?.name ?? id;
  },
  taskTitle(id) {
    return session.taskTitles.get(id) ?? null;
  },
};

/**
 * @param {string} text
 */
function setStatus(text) {
  replace(document, ui.status, text);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ist die Sitzung abgelaufen, geht es zurück zur Anmeldung.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function handleAuthError(error) {
  if (error instanceof ApiError && error.status === 401) {
    showLogin("Sitzung abgelaufen, bitte neu anmelden.");
    return true;
  }
  return false;
}

/**
 * @param {string} [notice]
 */
function showLogin(notice) {
  stopLive();
  api.csrfToken = null;
  session.state = null;
  ui.app.hidden = true;
  ui.logout.hidden = true;
  ui.login.hidden = false;
  replace(document, ui.loginError, notice ?? "");
  replace(document, ui.consoleLink);
  setStatus("Nicht angemeldet");
  ui.password.focus();
}

async function showApp() {
  ui.login.hidden = true;
  ui.app.hidden = false;
  ui.logout.hidden = false;
  session.timelineSeq = 0;
  session.chatSeq = 0;
  session.chatPartner = "";
  session.taskTitles.clear();
  replace(document, ui.timeline);
  replace(document, ui.chatLog);
  setStatus("Lade …");
  await refresh();
  await refreshPullRequests();
  startLive();
  session.prTimer = setInterval(() => {
    void refreshPullRequests();
  }, PR_REFRESH_MS);
}

/** Holt alles Neue. Läuft nie doppelt; ein Aufruf währenddessen holt danach noch einmal. */
async function refresh() {
  if (session.refreshing) {
    session.refreshAgain = true;
    return;
  }
  session.refreshing = true;
  try {
    do {
      session.refreshAgain = false;
      await loadState();
      await loadTimeline();
      await loadChat();
    } while (session.refreshAgain);
    setStatus(session.socket?.readyState === WebSocket.OPEN ? "Live" : "Verbinde …");
  } catch (error) {
    if (!handleAuthError(error)) {
      setStatus(`Fehler: ${message(error)}`);
    }
  } finally {
    session.refreshing = false;
  }
}

async function loadState() {
  const state = /** @type {OfficeStateView} */ (await api.get("/api/state"));
  session.state = state;
  for (const task of state.openTasks) {
    session.taskTitles.set(task.id, task.title);
  }
  replace(document, ui.agents, renderAgents(document, state, lookup));
  replace(document, ui.costs, renderCosts(document, state));
  replace(document, ui.consoleLink, renderConsoleLink(document, state.consoleUrl));
  updateRecipients(state);
}

/**
 * Empfänger im Chat. Mit der Weisung aus E46 nur der COO.
 *
 * @param {OfficeStateView} state
 */
function updateRecipients(state) {
  const agents = state.ceoViaCooOnly
    ? state.agents.filter((a) => a.id === state.cooId)
    : state.agents;
  const previous = ui.chatTo.value;
  replace(
    document,
    ui.chatTo,
    ...agents.map((agent) => {
      const option = h(document, "option", null, `${agent.name} (${agent.role})`);
      option.value = agent.id;
      return option;
    }),
  );
  const wanted = agents.some((a) => a.id === previous) ? previous : (state.cooId ?? "");
  if (agents.some((a) => a.id === wanted)) {
    ui.chatTo.value = wanted;
  }
}

async function loadTimeline() {
  const first = session.timelineSeq === 0;
  const path = first
    ? `/api/timeline?last=${String(INITIAL_ITEMS)}`
    : `/api/timeline?after=${String(session.timelineSeq)}&limit=${String(PAGE)}`;
  const data = /** @type {{ events: TimelineEvent[], lastSeq: number }} */ (await api.get(path));
  for (const event of data.events) {
    if (event.type === "task.created") {
      const payload = /** @type {Record<string, unknown>} */ (event.payload);
      if (typeof payload["title"] === "string") {
        session.taskTitles.set(event.id, payload["title"]);
      }
    }
    // Neueste oben.
    ui.timeline.prepend(renderTimelineItem(document, event, lookup));
    session.timelineSeq = Math.max(session.timelineSeq, event.seq);
  }
  if (first && data.events.length === 0) {
    session.timelineSeq = data.lastSeq;
  }
  while (ui.timeline.childElementCount > MAX_TIMELINE_ITEMS) {
    ui.timeline.lastElementChild?.remove();
  }
  if (!first && data.events.length === PAGE) {
    session.refreshAgain = true;
  }
}

async function loadChat() {
  const partner = ui.chatTo.value;
  if (partner === "") {
    return;
  }
  if (partner !== session.chatPartner) {
    session.chatPartner = partner;
    session.chatSeq = 0;
    replace(document, ui.chatLog);
  }
  const query = new URLSearchParams({ with: partner });
  if (session.chatSeq === 0) {
    query.set("last", String(INITIAL_ITEMS));
  } else {
    query.set("after", String(session.chatSeq));
  }
  const data = /** @type {{ messages: ChatMessage[] }} */ (
    await api.get(`/api/chat?${query.toString()}`)
  );
  // Während der Anfrage kann der Partner gewechselt haben.
  if (partner !== session.chatPartner) {
    return;
  }
  for (const chat of data.messages) {
    if (chat.seq <= session.chatSeq) {
      continue;
    }
    ui.chatLog.append(renderChatMessage(document, chat, lookup));
    session.chatSeq = chat.seq;
  }
  if (data.messages.length > 0) {
    ui.chatLog.lastElementChild?.scrollIntoView({ block: "nearest" });
  }
}

async function refreshPullRequests() {
  if (session.state === null) {
    return;
  }
  try {
    const data = /** @type {{ available: boolean, pullRequests: PullRequestView[] }} */ (
      await api.get("/api/prs")
    );
    replace(document, ui.prs, renderPullRequests(document, data, lookup));
  } catch (error) {
    if (!handleAuthError(error)) {
      replace(document, ui.prs, `PRs nicht ladbar: ${message(error)}`);
    }
  }
}

function startLive() {
  stopLive();
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${scheme}//${location.host}/api/live`);
  session.socket = socket;
  socket.addEventListener("open", () => {
    session.reconnectMs = 1000;
    setStatus("Live");
  });
  socket.addEventListener("message", (event) => {
    let data;
    try {
      data = /** @type {unknown} */ (JSON.parse(String(event.data)));
    } catch {
      return;
    }
    if (typeof data !== "object" || data === null) {
      return;
    }
    const lastSeq = /** @type {Record<string, unknown>} */ (data)["lastSeq"];
    if (typeof lastSeq === "number" && lastSeq > session.liveSeq) {
      session.liveSeq = lastSeq;
      void refresh();
      void refreshPullRequests();
    }
  });
  socket.addEventListener("close", () => {
    if (session.socket !== socket) {
      return;
    }
    session.socket = null;
    const wait = session.reconnectMs;
    session.reconnectMs = Math.min(wait * 2, MAX_RECONNECT_MS);
    setStatus(`Getrennt, neuer Versuch in ${String(Math.round(wait / 1000))} s`);
    session.reconnectTimer = setTimeout(() => {
      // Prüft zuerst die Sitzung: Ist sie abgelaufen, endet hier die Schleife.
      void checkSession().then((active) => {
        if (active) {
          startLive();
          void refresh();
        }
      });
    }, wait);
  });
}

function stopLive() {
  clearTimeout(session.reconnectTimer);
  clearInterval(session.prTimer);
  const socket = session.socket;
  session.socket = null;
  socket?.close();
}

/** @returns {Promise<boolean>} */
async function checkSession() {
  try {
    const data = /** @type {{ authenticated: boolean, csrfToken?: string }} */ (
      await api.get("/api/session")
    );
    if (!data.authenticated || data.csrfToken === undefined) {
      showLogin(api.csrfToken === null ? "" : "Sitzung abgelaufen, bitte neu anmelden.");
      return false;
    }
    api.csrfToken = data.csrfToken;
    return true;
  } catch (error) {
    setStatus(`Office nicht erreichbar: ${message(error)}`);
    return false;
  }
}

ui.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const password = ui.password.value;
  replace(document, ui.loginError);
  void api
    .post("/api/login", { password })
    .then((data) => {
      ui.password.value = "";
      api.csrfToken = /** @type {{ csrfToken: string }} */ (data).csrfToken;
      return showApp();
    })
    .catch((/** @type {unknown} */ error) => {
      replace(document, ui.loginError, message(error));
    });
});

ui.logout.addEventListener("click", () => {
  void api
    .post("/api/logout", {})
    .catch(() => undefined)
    .then(() => {
      showLogin("Abgemeldet.");
    });
});

ui.chatTo.addEventListener("change", () => {
  void refresh();
});

ui.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = ui.chatText.value;
  if (text.trim() === "") {
    return;
  }
  const to = ui.chatTo.value;
  const kind = ui.chatKind.value;
  const draft = session.draft;
  if (draft.text !== text || draft.to !== to || draft.kind !== kind || draft.clientId === "") {
    session.draft = { text, to, kind, clientId: crypto.randomUUID() };
  }
  ui.chatSend.disabled = true;
  replace(document, ui.chatError);
  void api
    .post("/api/chat", { to, kind, text, clientId: session.draft.clientId })
    .then(() => {
      ui.chatText.value = "";
      session.draft = { text: "", to: "", kind: "", clientId: "" };
      return refresh();
    })
    .catch((/** @type {unknown} */ error) => {
      if (!handleAuthError(error)) {
        // Der Entwurf bleibt; ein erneutes Senden nutzt dieselbe clientId.
        replace(document, ui.chatError, message(error));
      }
    })
    .finally(() => {
      ui.chatSend.disabled = false;
    });
});

void checkSession().then((active) => {
  if (active) {
    void showApp();
  }
});
