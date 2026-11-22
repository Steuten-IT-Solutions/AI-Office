import { CEO_ID, type AgentProfile } from "../domain/agent.ts";
import type { Room } from "../domain/building.ts";
import type { Office } from "../domain/office.ts";
import { canonicalJson } from "../events/canonical-json.ts";
import type { IpcParams, IpcResult } from "./protocol.ts";

/**
 * Meldet Räume und Agentenprofile beim Supervisor an (`workplaces.change`, `profile.check`,
 * plan.md Kap. 4.3, 4.6, 5.5). Ohne freigegebenes Profil und freigegebenen Raum lehnt die
 * Admission jeden Lauf ab (S03, Regeln `profile` und `room`). Das Office kennt Gebäude und
 * Startagenten nur als eigene Daten; der Supervisor erfährt sie erst hierüber.
 *
 * - Räume zuerst, dann Profile, Vorgesetzte vor ihren Mitarbeitern: Der Supervisor prüft, dass
 *   Raum und Vorgesetzter schon freigegeben sind.
 * - Gemeldet werden Räume mit Arbeitsplätzen und Räume, in denen ein Agent sitzt.
 * - Der Supervisor gibt dieselbe Version mit demselben Inhalt ohne neuen Eintrag frei. Der Abgleich
 *   meldet trotzdem nur, was sich seit der letzten Meldung geändert hat.
 * - Eine Ablehnung merkt er sich je Inhalt und schickt denselben Inhalt nicht noch einmal: Jede
 *   Ablehnung schreibt der Supervisor ins Audit-Log. Nach einem Neustart des Office versucht er es
 *   einmal neu.
 * - Scheitert ein Aufruf technisch, versucht es der nächste Durchlauf wieder.
 */

export interface ProfileAccess {
  changeWorkplaces(params: IpcParams<"workplaces.change">): Promise<IpcResult<"workplaces.change">>;
  checkProfile(params: IpcParams<"profile.check">): Promise<IpcResult<"profile.check">>;
}

export interface SyncRejection {
  kind: "raum" | "profil";
  id: string;
  reason: string;
}

export interface ProfileSyncResult {
  /** In diesem Durchlauf freigegeben. */
  approved: { kind: "raum" | "profil"; id: string }[];
  /** Alle Ablehnungen, die noch gelten, auch aus früheren Durchläufen. */
  rejected: SyncRejection[];
  /** Technisch gescheitert oder zurückgestellt; der nächste Durchlauf versucht es wieder. */
  failed: { kind: "raum" | "profil"; id: string; error: string }[];
}

/** Parameter für `workplaces.change` aus einem Raum des Gebäudes. */
export function workplacesParams(room: Room): IpcParams<"workplaces.change"> {
  return { roomId: room.id, workplaces: room.workplaces, equipment: [...room.equipment] };
}

/** Parameter für `profile.check`: nur die Felder, die die Richtlinie betreffen. */
export function profileParams(profile: AgentProfile): IpcParams<"profile.check"> {
  return {
    agentId: profile.id,
    version: profile.version,
    role: profile.role,
    supervisorId: profile.supervisorId,
    models: {
      default: profile.models.default,
      additional: [...new Set(profile.models.additional.map((choice) => choice.model))],
    },
    equipment: [...profile.equipment],
    roomId: profile.roomId,
  };
}

interface Known {
  /** Inhalt (kanonisches JSON) der letzten Meldung. */
  content: string;
  /** `null`: freigegeben, sonst der Grund der Ablehnung. */
  rejection: string | null;
}

export class ProfileSync {
  private readonly office: Office;
  private readonly access: ProfileAccess;
  private readonly rooms = new Map<string, Known>();
  private readonly profiles = new Map<string, Known>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { office: Office; access: ProfileAccess }) {
    this.office = options.office;
    this.access = options.access;
  }

  /** Ein Abgleich. Nie zwei gleichzeitig. */
  sync(): Promise<ProfileSyncResult> {
    const next = this.queue.then(() => this.run());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run(): Promise<ProfileSyncResult> {
    const result: ProfileSyncResult = { approved: [], rejected: [], failed: [] };
    this.office.sync();
    const state = this.office.state;
    const agents = state.agents();
    const used = new Set(agents.map((agent) => agent.roomId));
    const rooms = state.building.floors
      .flatMap((floor) => floor.rooms)
      .filter((room) => room.workplaces > 0 || used.has(room.id));

    for (const room of rooms) {
      const params = workplacesParams(room);
      await this.send("raum", room.id, params, this.rooms, result, () =>
        this.access.changeWorkplaces(params),
      );
    }
    for (const agent of byHierarchy(agents)) {
      const params = profileParams(agent);
      const room = this.rooms.get(agent.roomId);
      if (room === undefined || room.rejection !== null) {
        result.failed.push({
          kind: "profil",
          id: agent.id,
          error: `Raum ${agent.roomId} nicht freigegeben`,
        });
        continue;
      }
      if (agent.supervisorId !== CEO_ID) {
        const boss = this.profiles.get(agent.supervisorId);
        if (boss === undefined || boss.rejection !== null) {
          result.failed.push({
            kind: "profil",
            id: agent.id,
            error: `Vorgesetzter ${agent.supervisorId} nicht freigegeben`,
          });
          continue;
        }
      }
      await this.send("profil", agent.id, params, this.profiles, result, () =>
        this.access.checkProfile(params),
      );
    }

    for (const [kind, known] of [
      ["raum", this.rooms],
      ["profil", this.profiles],
    ] as const) {
      for (const [id, entry] of known) {
        if (entry.rejection !== null) {
          result.rejected.push({ kind, id, reason: entry.rejection });
        }
      }
    }
    return result;
  }

  private async send(
    kind: "raum" | "profil",
    id: string,
    params: IpcParams<"workplaces.change"> | IpcParams<"profile.check">,
    known: Map<string, Known>,
    result: ProfileSyncResult,
    call: () => Promise<IpcResult<"profile.check">>,
  ): Promise<void> {
    const content = canonicalJson(params);
    if (known.get(id)?.content === content) {
      return;
    }
    let verdict: IpcResult<"profile.check">;
    try {
      verdict = await call();
    } catch (error) {
      result.failed.push({
        kind,
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (verdict.allowed) {
      known.set(id, { content, rejection: null });
      result.approved.push({ kind, id });
    } else {
      known.set(id, { content, rejection: verdict.reason });
    }
  }
}

/** Agenten so geordnet, dass jeder Vorgesetzte vor seinen Mitarbeitern kommt. */
function byHierarchy(agents: readonly AgentProfile[]): AgentProfile[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const depth = (agent: AgentProfile): number => {
    const seen = new Set<string>();
    let level = 0;
    for (let current = agent; current.supervisorId !== CEO_ID; level += 1) {
      const boss = byId.get(current.supervisorId);
      if (boss === undefined || seen.has(boss.id)) {
        return Number.MAX_SAFE_INTEGER;
      }
      seen.add(boss.id);
      current = boss;
    }
    return level;
  };
  return [...agents]
    .map((agent) => ({ agent, level: depth(agent) }))
    .sort((a, b) => a.level - b.level || a.agent.id.localeCompare(b.agent.id))
    .map(({ agent }) => agent);
}
