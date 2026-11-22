import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createOfficeApiServer } from "./api/mcp-server.ts";
import { RunTokens } from "./api/run-tokens.ts";
import { LISTEN_ADDRESS, type OfficeConfig } from "./config.ts";
import { buildContext } from "./domain/context.ts";
import { Office } from "./domain/office.ts";
import { loadStartBooks, loadStartPersonas } from "./domain/start-content.ts";
import { loadStartData, seedStartAgents } from "./domain/start-data.ts";
import { EventStore } from "./events/event-store.ts";
import { HeadReporter } from "./events/head-reporter.ts";
import { OfficeGateway, createGatewayServer } from "./gateway/gateway.ts";
import { readPasswordFile } from "./gateway/password.ts";
import { StaticFiles } from "./gateway/static-files.ts";
import { FingerprintReporter, fingerprintsFirst } from "./git/fingerprints.ts";
import { MergeStatusFollower } from "./git/merge-follower.ts";
import { GitOutcomeFollower } from "./git/outcome-follower.ts";
import {
  SupervisorClient,
  supervisorEscalationGate,
  supervisorGitAccess,
  supervisorProfileAccess,
  supervisorRunAccess,
  supervisorRunRequester,
} from "./ipc/client.ts";
import { ProfileSync } from "./ipc/profile-sync.ts";
import { errorText, type Logger } from "./log.ts";
import { Planner } from "./planner/planner.ts";
import { RunFollower } from "./runs/run-follower.ts";
import { OfficeTakt, type TaktIntervals } from "./takt.ts";
import { OFFICE_VERSION } from "./version.ts";

/**
 * Der Office-Prozess (plan.md Kap. 3.2): verbindet Ereignisprotokoll, Planer, Begleiter der
 * Läufe, Office-API und Office-Gateway und startet den Takt. `main.ts` ruft das mit den
 * Einstellungen aus der Umgebung auf; Tests mit freien Ports und einem Supervisor-Double.
 *
 * Reihenfolge beim Start: erst alles prüfen, was ohne Datenbank geht (Verfassung, Startdaten),
 * dann Datenbank und Migrationen, dann die Server, zuletzt der Takt. Scheitert ein Schritt, ist
 * alles schon Geöffnete wieder geschlossen.
 *
 * Weisungen des CEO (Kap. 4.4) gibt es noch nicht als Ereignis; der Kontext bekommt deshalb eine
 * leere Liste. Kontingent und PR-Liste für das Webinterface liefert der Supervisor noch nicht
 * (S04, Kap. 5.11); das Webinterface zeigt dann „noch keine Messung“ bzw. „nicht angebunden“.
 */

export interface StartOptions {
  log: Logger;
  /** Uhr für Ereignisse und Planer. Standard: Systemzeit. */
  now?: () => Date;
  intervals?: Partial<TaktIntervals>;
  /** Gebautes Webinterface. Standard: `packages/office/web/dist/`. */
  web?: StaticFiles;
  /** Wartezeit beim Beenden, bis offene HTTP-Verbindungen hart getrennt werden. */
  closeTimeoutMs?: number;
}

export interface RunningOffice {
  /** Tatsächliche Ports, wichtig bei Port 0. */
  gatewayPort: number;
  apiPort: number;
  office: Office;
  takt: OfficeTakt;
  /** Beendet Takt, Server und Verbindungen und schließt die Datenbank. */
  stop(): Promise<void>;
}

/** Wartezeit beim Beenden. systemd wartet laut `aio-office.service` 30 s (`TimeoutStopSec`). */
export const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/** Liest die Verfassung. Fehlt sie oder ist sie leer, startet das Office nicht. */
export function readConstitution(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Verfassung unter ${path} nicht lesbar (${errorText(error)}); ohne sie baut das Office keinen Kontext (Kap. 4.1)`,
      { cause: error },
    );
  }
  if (text.trim() === "") {
    throw new Error(`Verfassung unter ${path} ist leer`);
  }
  return text.trim();
}

export async function startOffice(
  config: OfficeConfig,
  options: StartOptions,
): Promise<RunningOffice> {
  const { log } = options;
  const constitution = readConstitution(config.constitutionPath);
  const start = loadStartData();
  const books = loadStartBooks();
  const personas = loadStartPersonas();

  const cleanup: (() => Promise<void> | void)[] = [];
  const closeAll = async () => {
    for (const step of cleanup.reverse()) {
      try {
        await step();
      } catch (error) {
        log.error("Beenden: Schritt fehlgeschlagen", { error: errorText(error) });
      }
    }
    cleanup.length = 0;
  };

  try {
    const store = EventStore.open(config.dbPath);
    cleanup.push(() => {
      store.close();
    });
    log.info("Ereignisprotokoll geöffnet", {
      path: config.dbPath,
      databaseVersion: store.migration.databaseVersion,
      codeVersion: store.migration.codeVersion,
      applied: store.migration.applied.join(",") || null,
    });
    const chain = store.verifyChain();
    if (chain.ok) {
      log.info("Hash-Kette geprüft", { seq: chain.head.seq });
    } else {
      // Maßgeblich ist das Audit-Log des Supervisors (E38); das Office läuft weiter und meldet es.
      log.error("Hash-Kette gebrochen", { brokenAtSeq: chain.brokenAtSeq, reason: chain.reason });
    }

    const office = Office.open(store, start.building, options.now ? { now: options.now } : {});
    for (const agent of seedStartAgents(office, start.agents)) {
      log.info("Startagent eingestellt", { agentId: agent.id });
    }

    const client = new SupervisorClient({ socketPath: config.socketPath });
    cleanup.push(() => client.close());
    const git = supervisorGitAccess(client);
    const tokens = new RunTokens();
    const fingerprints = new FingerprintReporter({ office, access: git });
    const planner = new Planner({
      office,
      requester: fingerprintsFirst(supervisorRunRequester(client), fingerprints),
      context: (state, agentId, taskId) =>
        buildContext({ state, agentId, taskId, constitution, directives: [], books, personas }),
    });
    const takt = new OfficeTakt({
      parts: {
        profiles: new ProfileSync({ office, access: supervisorProfileAccess(client) }),
        planner,
        runs: new RunFollower({ office, access: supervisorRunAccess(client), tokens }),
        gitOutcomes: new GitOutcomeFollower({ office, access: git }),
        merges: new MergeStatusFollower({ office, access: git }),
        fingerprints,
        head: new HeadReporter({
          store,
          access: { reportHead: (params) => client.call("office.reportHead", params) },
        }),
        tokens,
      },
      log,
      ...(options.intervals ? { intervals: options.intervals } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    // Vor dem Client schließen: Laufende Durchläufe brauchen ihn noch.
    cleanup.push(() => takt.stop());

    const report = (component: string) => (message: string, error: unknown) => {
      log.error(message, { component, error: errorText(error) });
    };
    const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;

    const api = createOfficeApiServer({
      office,
      tokens,
      gate: supervisorEscalationGate(client),
      log: report("office-api"),
    });
    const apiPort = await listen(api, config.apiPort);
    cleanup.push(() => close(api, closeTimeoutMs));

    const web = options.web ?? new StaticFiles();
    if (!web.built) {
      log.warn("Webinterface nicht gebaut (pnpm --filter @ai-office/office build:web)");
    }
    const gateway = new OfficeGateway({
      office,
      store,
      host: config.webHost,
      passwordHash: () => readPasswordFile(config.passwordFile),
      onCeoMessage: () => {
        takt.kick("planner");
      },
      log: report("gateway"),
      web,
      ...(config.consoleUrl === null ? {} : { consoleUrl: config.consoleUrl }),
    });
    const gatewayServer = createGatewayServer(gateway);
    const gatewayPort = await listen(gatewayServer, config.gatewayPort);
    cleanup.push(() => close(gatewayServer, closeTimeoutMs));
    gateway.start();
    cleanup.push(() => {
      gateway.stop();
    });
    if (readPasswordFile(config.passwordFile) === null) {
      log.warn("Kein Passwort für den CEO eingerichtet; Anmeldung erst nach `main.ts passwort`", {
        path: config.passwordFile,
      });
    }

    takt.start();
    log.info("Office gestartet", {
      version: OFFICE_VERSION,
      gateway: `${LISTEN_ADDRESS}:${String(gatewayPort)}`,
      officeApi: `${LISTEN_ADDRESS}:${String(apiPort)}`,
      host: config.webHost,
      socket: config.socketPath,
    });

    let stopping: Promise<void> | undefined;
    return {
      gatewayPort,
      apiPort,
      office,
      takt,
      stop() {
        stopping ??= closeAll().then(() => {
          log.info("Office beendet");
        });
        return stopping;
      },
    };
  } catch (error) {
    await closeAll();
    throw error;
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => {
      reject(error);
    };
    server.once("error", failed);
    server.listen(port, LISTEN_ADDRESS, () => {
      server.off("error", failed);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Nimmt keine Verbindungen mehr an; offene trennt es nach `timeoutMs` hart. */
function close(server: Server, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
    }, timeoutMs);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}
