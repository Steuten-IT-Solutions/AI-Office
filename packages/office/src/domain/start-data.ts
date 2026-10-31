import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAgentProfile, type AgentProfile } from "./agent.ts";
import { parseBuilding, type Building } from "./building.ts";
import type { Office } from "./office.ts";
import { ValidationError } from "./validation.ts";

/** Startzustand der Firma als Daten (plan.md Kap. 5.6, 5.12), siehe `data/start/README.md`. */
export const DEFAULT_START_DIR = join(import.meta.dirname, "..", "..", "data", "start");

export interface StartData {
  building: Building;
  agents: AgentProfile[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** Liest und prüft Gebäude und Startagenten. Wirft `ValidationError` mit allen Befunden. */
export function loadStartData(directory: string = DEFAULT_START_DIR): StartData {
  const building = parseBuilding(readJson(join(directory, "building.json")));
  if (!building.ok) {
    throw new ValidationError("building.json", building.issues);
  }
  const agentDir = join(directory, "agents");
  const agents = readdirSync(agentDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const profile = parseAgentProfile(readJson(join(agentDir, name)));
      if (!profile.ok) {
        throw new ValidationError(`agents/${name}`, profile.issues);
      }
      if (`${profile.value.id}.json` !== name) {
        throw new ValidationError(`agents/${name}`, ["Dateiname muss der ID entsprechen"]);
      }
      return profile.value;
    });
  return { building: building.value, agents };
}

/**
 * Stellt die Startagenten ein, die noch nicht im Ereignisprotokoll stehen. Mehrfacher Aufruf
 * ist unschädlich. Vorgesetzte kommen vor ihren Mitarbeitern an die Reihe.
 */
export function seedStartAgents(office: Office, agents: readonly AgentProfile[]): AgentProfile[] {
  const hired: AgentProfile[] = [];
  const pending = agents.filter((agent) => office.state.agent(agent.id) === undefined);
  while (pending.length > 0) {
    const index = pending.findIndex((agent) => office.state.isParticipant(agent.supervisorId));
    if (index === -1) {
      throw new ValidationError("Startagenten", [
        `Vorgesetzte fehlen für ${pending.map((agent) => agent.id).join(", ")}`,
      ]);
    }
    const [agent] = pending.splice(index, 1) as [AgentProfile];
    hired.push(office.hireAgent("system", agent, { idempotencyKey: `start:${agent.id}` }));
  }
  return hired;
}
