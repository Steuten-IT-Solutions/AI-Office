import { EQUIPMENT, type Equipment } from "./agent.ts";
import { Reader, parsed, type Parsed } from "./validation.ts";

/**
 * Gebäude als Daten (plan.md Kap. 5.6). Im MVP ist das Gebäude fest (Kap. 7.3); Umbau mit
 * Layout-Engine folgt in Etappe 3. Deshalb gibt es noch keine Ereignisse für das Gebäude.
 *
 * Gebäude / Etage / Raum = Firma / Bereich (Sichtbarkeit) / Ort für Arbeit oder Kommunikation.
 * Die Zahl der Arbeitsplätze eines Raums ist die Parallelität, die die Firma selbst steuert
 * (E4). Die physikalische Grenze (Statik) setzt der Supervisor.
 */

export const ROOM_KINDS = ["eingang", "eingangsbereich", "buero"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

export interface Room {
  id: string;
  name: string;
  kind: RoomKind;
  /** Mögliche gleichzeitige Läufe in diesem Raum. */
  workplaces: number;
  equipment: Equipment[];
}

export interface Floor {
  id: string;
  name: string;
  rooms: Room[];
}

export interface Building {
  id: string;
  name: string;
  floors: Floor[];
}

export function parseBuilding(value: unknown): Parsed<Building> {
  const r = new Reader(value, "gebaeude").only("id", "name", "floors");
  const building: Building = {
    id: r.id("id"),
    name: r.string("name"),
    floors: r.objects("floors").map((f) => {
      f.only("id", "name", "rooms");
      return {
        id: f.id("id"),
        name: f.string("name"),
        rooms: f.objects("rooms").map((room) => {
          room.only("id", "name", "kind", "workplaces", "equipment");
          return {
            id: room.id("id"),
            name: room.string("name"),
            kind: room.oneOf("kind", ROOM_KINDS),
            workplaces: room.integer("workplaces", 0, 1000),
            equipment: room.setOf("equipment", EQUIPMENT),
          };
        }),
      };
    }),
  };
  if (building.floors.length === 0) {
    r.issues.push("gebaeude.floors: mindestens eine Etage erwartet");
  }
  const seen = new Set<string>();
  for (const id of [
    ...building.floors.map((f) => f.id),
    ...building.floors.flatMap((f) => f.rooms.map((room) => room.id)),
  ]) {
    if (id !== "" && seen.has(id)) {
      r.issues.push(`gebaeude: ID ${id} ist doppelt vergeben`);
    }
    seen.add(id);
  }
  return parsed(r, building);
}

export function findRoom(building: Building, roomId: string): Room | undefined {
  for (const floor of building.floors) {
    const room = floor.rooms.find((candidate) => candidate.id === roomId);
    if (room !== undefined) {
      return room;
    }
  }
  return undefined;
}

export function totalWorkplaces(building: Building): number {
  return building.floors.reduce(
    (sum, floor) => sum + floor.rooms.reduce((roomSum, room) => roomSum + room.workplaces, 0),
    0,
  );
}
