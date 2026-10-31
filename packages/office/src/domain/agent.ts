import type { RunType } from "../llm/runner.ts";
import { Reader, parsed, type Parsed } from "./validation.ts";

/**
 * Agentenprofil (plan.md Kap. 5.1, 5.12): ein versionierter Datensatz, kein Prozess (Kap. 3.1).
 *
 * Kompetenz kommt aus Modell, Werkzeugen, Wissen und Rechten. Die Persönlichkeit steuert den
 * Entscheidungsstil und erscheint im Prompt als konkrete Verhaltensregeln, nicht als Skalenzahl
 * (Kap. 5.12). Den Prompt baut P07 aus diesen Daten.
 *
 * Rechte, Ausstattung und Modell prüft beim Anlegen oder Ändern der Supervisor gegen seine
 * Richtlinie (Kap. 4.6, E22). Die Prüfungen hier sind nur Komfort.
 */

export const MODEL_ALIASES = ["haiku", "sonnet", "opus"] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

/** Ausstattung = Werkzeugrechte (Kap. 5.6). */
export const EQUIPMENT = ["werkbank", "rechner", "whiteboard", "regal"] as const;
export type Equipment = (typeof EQUIPMENT)[number];

/** Gemüt: fünf Skalen von 1 bis 5 (Kap. 5.1), Reihenfolge wie in Kap. 5.12 (O/G/E/V/B). */
export interface Temperament {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  resilience: number;
}

export interface ModelChoice {
  model: ModelAlias;
  /** Wofür dieses Modell statt des Standardmodells gilt, z. B. „Architektur“. */
  purpose: string;
}

export interface Weakness {
  /** Bewusste Schwäche (Kap. 5.12). */
  description: string;
  /** Begrenzung, damit die Schwäche nicht zu Blockaden oder Kostenschleifen führt. */
  limit: string;
}

export interface AgentProfile {
  id: string;
  /** Profilversion, beginnt bei 1. Jede Änderung erhöht sie um genau 1. */
  version: number;
  name: string;
  role: string;
  age: number;
  /** ID des Vorgesetzten; `ceo` für den CEO. */
  supervisorId: string;
  specializations: string[];
  temperament: Temperament;
  attitude: string;
  background: string;
  education: string;
  behaviorRules: string[];
  weakness: Weakness;
  /** Rollen, die die Schwäche ausgleichen, als Text (Kap. 5.12 „Gegengewicht“). */
  counterweight: string;
  models: { default: ModelAlias; additional: ModelChoice[] };
  equipment: Equipment[];
  /** Raum mit dem Arbeitsplatz im Gebäude. */
  roomId: string;
  avatarSeed: string;
}

/** Die ID des CEO. Der CEO ist kein Agent, kann aber Vorgesetzter und Absender sein. */
export const CEO_ID = "ceo";

export function parseAgentProfile(value: unknown): Parsed<AgentProfile> {
  const r = new Reader(value, "profil").only(
    "id",
    "version",
    "name",
    "role",
    "age",
    "supervisorId",
    "specializations",
    "temperament",
    "attitude",
    "background",
    "education",
    "behaviorRules",
    "weakness",
    "counterweight",
    "models",
    "equipment",
    "roomId",
    "avatarSeed",
  );
  const id = r.id("id");
  const temperament = r
    .object("temperament")
    .only("openness", "conscientiousness", "extraversion", "agreeableness", "resilience");
  const weakness = r.object("weakness").only("description", "limit");
  const models = r.object("models").only("default", "additional");
  const profile: AgentProfile = {
    id,
    version: r.integer("version", 1, Number.MAX_SAFE_INTEGER),
    name: r.string("name", { maxLength: 100 }),
    role: r.string("role", { maxLength: 100 }),
    age: r.integer("age", 18, 99),
    supervisorId: r.id("supervisorId"),
    specializations: r.strings("specializations", { min: 1 }),
    temperament: {
      openness: temperament.integer("openness", 1, 5),
      conscientiousness: temperament.integer("conscientiousness", 1, 5),
      extraversion: temperament.integer("extraversion", 1, 5),
      agreeableness: temperament.integer("agreeableness", 1, 5),
      resilience: temperament.integer("resilience", 1, 5),
    },
    attitude: r.string("attitude"),
    background: r.string("background"),
    education: r.string("education"),
    behaviorRules: r.strings("behaviorRules", { min: 1 }),
    weakness: { description: weakness.string("description"), limit: weakness.string("limit") },
    counterweight: r.string("counterweight"),
    models: {
      default: models.oneOf("default", MODEL_ALIASES),
      additional: models.objects("additional").map((m) => {
        m.only("model", "purpose");
        return { model: m.oneOf("model", MODEL_ALIASES), purpose: m.string("purpose") };
      }),
    },
    equipment: r.setOf("equipment", EQUIPMENT),
    roomId: r.id("roomId"),
    avatarSeed: r.string("avatarSeed", { maxLength: 100 }),
  };
  if (id !== "" && id === profile.supervisorId) {
    r.issues.push("profil.supervisorId: ein Agent kann nicht sein eigener Vorgesetzter sein");
  }
  if (id === CEO_ID) {
    r.issues.push(`profil.id: ${CEO_ID} ist für den CEO reserviert`);
  }
  return parsed(r, profile);
}

/**
 * Lauftypen, die die Ausstattung erlaubt (Kap. 5.6, 5.7): Werkbank = `werkbank`,
 * Rechner = `recherche`, `buero` braucht keine Ausstattung. Nur Komfort für Planer und
 * Kontextaufbau; die Richtlinie setzt der Supervisor durch (Kap. 4.6).
 */
export function allowedRunTypes(equipment: readonly Equipment[]): RunType[] {
  const types: RunType[] = ["buero"];
  if (equipment.includes("werkbank")) {
    types.push("werkbank");
  }
  if (equipment.includes("rechner")) {
    types.push("recherche");
  }
  return types;
}
