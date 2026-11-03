/*
 * KOPIE von `packages/supervisor/src/ipc/protocol.ts` aus Steuten-IT-Solutions/ai-office-supervisor,
 * Stand 3dff78a (S02). Unterhalb dieses Kommentars unverändert; geändert wird nur mit einer neuen
 * Protokollversion, und dann zuerst im Supervisor (P02, plan.md Kap. 4.6).
 *
 * Die Prüfungen hier dienen im Office nur dem Komfort (E22): Fehler fallen auf, bevor eine
 * Anfrage den Socket erreicht. Maßgeblich ist die Prüfung im Supervisor.
 */

import { z } from "zod";

/**
 * IPC-Protokoll zwischen Office und Supervisor, Version 1 (plan.md Kap. 4.6, 4.7, E22, E25).
 *
 * Das Office ist nicht vertrauenswürdig. Jede Nachricht wird deshalb vollständig gegen ein
 * striktes Schema geprüft, unbekannte Felder werden abgelehnt.
 *
 * Übertragung: eine JSON-Nachricht je Zeile (UTF-8, `\n` als Trenner) über den Unix-Socket.
 *
 * Anfrage:  `{"v":1,"id":"…","method":"run.request","params":{…}}`
 * Antwort:  `{"v":1,"id":"…","ok":true,"result":{…}}`
 *           `{"v":1,"id":"…","ok":false,"error":{"code":"…","message":"…"}}`
 *
 * Versionierung: Jede Anfrage nennt ihre Version in `v`. Der Supervisor beantwortet nur
 * Versionen aus `SUPPORTED_VERSIONS`, sonst `unsupported_version` mit der Liste. Eine neue
 * Version bekommt eigene Schemas; v1 bleibt unverändert, solange das Office sie spricht. Der
 * Client im Office (P02) ist eine Kopie dieser Datei, fest auf eine Version.
 *
 * Die Methoden folgen der abschließenden Liste in Kap. 4.6. Git-Übergabe, PR und Merge-Antrag
 * fehlen bewusst: Sie kommen nach E40 direkt aus dem Container über das Supervisor-Gateway (S07),
 * nicht über das Office.
 */

export const PROTOCOL_VERSION = 1;
export const SUPPORTED_VERSIONS: readonly number[] = [PROTOCOL_VERSION];

/** Obergrenze einer Zeile in Bytes, ohne `\n`. Ein Prompt ist Daten, aber nicht beliebig groß. */
export const MAX_FRAME_BYTES = 1024 * 1024;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Kennung einer Anfrage, vom Office gewählt. Nur zur Zuordnung der Antwort. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const RUN_TYPES = ["werkbank", "buero", "recherche"] as const;
export const MODEL_ALIASES = ["haiku", "sonnet", "opus"] as const;
export const EQUIPMENT = ["werkbank", "rechner", "whiteboard", "regal"] as const;

/** Längen in UTF-16-Einheiten wie bei `String.length`. */
export const MAX_PROMPT_CHARS = 400_000;
export const MAX_TEXT_CHARS = 20_000;
export const MAX_REASON_CHARS = 2_000;

/**
 * Text ohne ungepaarte Surrogate. Sie überstehen weder UTF-8 auf dem Socket noch SQLite
 * unverändert, ein Hash darüber passte später nicht mehr zum gespeicherten Wert.
 */
function text(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.isWellFormed(), { message: "enthält ungepaarte Surrogate" });
}

function uniqueList<T extends z.ZodType>(item: T, max: number) {
  return z
    .array(item)
    .max(max)
    .refine((list) => new Set(list).size === list.length, { message: "enthält Doppelte" });
}

const id = z.string().regex(ID_PATTERN);
const runType = z.enum(RUN_TYPES);
const model = z.enum(MODEL_ALIASES);
const equipment = uniqueList(z.enum(EQUIPMENT), EQUIPMENT.length);

/** Antwort einer Prüfung: erlaubt oder abgelehnt mit Grund. */
const verdict = z.discriminatedUnion("allowed", [
  z.strictObject({ allowed: z.literal(true) }),
  z.strictObject({ allowed: z.literal(false), reason: text(MAX_REASON_CHARS) }),
]);

/**
 * Lauf beantragen (Kap. 3.3, E25). Das Office liefert nur Agent, Lauftyp, Aufgabe, Repo,
 * gewünschtes Modell und den Prompt-Text. Werkzeuge, Grenzen und den CLI-Aufruf legt der
 * Supervisor fest (Kap. 5.7). Die Lauf-ID vergibt der Supervisor.
 */
const runRequestParams = z
  .strictObject({
    agentId: id,
    runType,
    /** ID des Ereignisses `task.created` im Office, `null` z. B. für einen CEO-Chat. */
    taskId: z.string().regex(UUID_PATTERN).nullable(),
    /** `owner/name`, nur bei `werkbank`. */
    repo: z.string().regex(REPO_PATTERN).nullable(),
    model,
    prompt: text(MAX_PROMPT_CHARS),
  })
  .refine((params) => (params.runType === "werkbank") === (params.repo !== null), {
    message: "repo ist genau bei werkbank anzugeben",
    path: ["repo"],
  });

const runRequestResult = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("admitted"), runId: id }),
  z.strictObject({ decision: z.literal("rejected"), reason: text(MAX_REASON_CHARS) }),
]);

/**
 * Profil anlegen oder ändern (Kap. 4.6, 5.5): nur die Felder, die die Richtlinie betreffen.
 * Persona-Texte bleiben Office-Daten.
 */
const profileCheckParams = z.strictObject({
  agentId: id,
  /** Profilversion, beginnt bei 1. */
  version: z.int().min(1),
  role: text(200),
  /** ID des Vorgesetzten, `ceo` für den CEO. */
  supervisorId: id,
  models: z.strictObject({
    default: model,
    additional: uniqueList(model, MODEL_ALIASES.length),
  }),
  equipment,
  roomId: id,
});

/** Arbeitsplätze eines Raums ändern (Kap. 4.3, 5.6). Ausstattung = Werkzeugrechte. */
const workplacesChangeParams = z.strictObject({
  roomId: id,
  workplaces: z.int().min(0).max(1000),
  equipment,
});

/** Eskalation an den CEO (Kap. 4.6, 5.4): Häufigkeit und Weisung aus E46 prüft der Supervisor. */
const escalationCheckParams = z.strictObject({
  runId: id,
  agentId: id,
  text: text(MAX_TEXT_CHARS),
});

/**
 * Kopf der Office-Kette sichern (E38). Der Supervisor schreibt ihn ins Audit-Log; ein späterer
 * Vergleich zeigt, ob das Office seine Kette nachträglich geändert hat.
 */
const officeHeadParams = z.strictObject({
  seq: z.int().min(0),
  hash: z.string().regex(SHA256_PATTERN),
});

const officeHeadResult = z.strictObject({ recorded: z.literal(true), auditSeq: z.int().min(1) });

export const METHODS = {
  "run.request": { params: runRequestParams, result: runRequestResult },
  "profile.check": { params: profileCheckParams, result: verdict },
  "workplaces.change": { params: workplacesChangeParams, result: verdict },
  "escalation.checkToCeo": { params: escalationCheckParams, result: verdict },
  "office.reportHead": { params: officeHeadParams, result: officeHeadResult },
} as const;

export type IpcMethod = keyof typeof METHODS;
export const IPC_METHODS = Object.keys(METHODS) as IpcMethod[];
export type IpcParams<M extends IpcMethod> = z.output<(typeof METHODS)[M]["params"]>;
export type IpcResult<M extends IpcMethod> = z.output<(typeof METHODS)[M]["result"]>;

export function isIpcMethod(value: unknown): value is IpcMethod {
  return typeof value === "string" && Object.hasOwn(METHODS, value);
}

export const requestEnvelope = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().regex(REQUEST_ID_PATTERN),
  method: z.string().max(100),
  params: z.unknown(),
});

export type RequestEnvelope = z.output<typeof requestEnvelope>;

export const ERROR_CODES = [
  /** Zeile ist kein JSON oder zu lang. Die Verbindung wird danach geschlossen. */
  "invalid_frame",
  /** Hülle der Anfrage ungültig (Felder, Typen, ID). */
  "invalid_request",
  "unsupported_version",
  "unknown_method",
  "invalid_params",
  /** Methode bekannt, im Supervisor aber noch nicht umgesetzt (kommt mit S03 ff.). */
  "not_available",
  /** Fehler im Supervisor, etwa beim Schreiben ins Audit-Log. */
  "internal",
] as const;
export type IpcErrorCode = (typeof ERROR_CODES)[number];

export interface IpcError {
  code: IpcErrorCode;
  message: string;
  /** Nur bei `unsupported_version`. */
  supported?: readonly number[];
}

export type ResponseEnvelope =
  | { v: number; id: string | null; ok: true; result: unknown }
  | { v: number; id: string | null; ok: false; error: IpcError };

/** Deutsche Meldungen von zod, je Prüfung statt global gesetzt. */
export const SCHEMA_LOCALE = z.locales.de().localeError;

/** Höchstzahl gemeldeter Schemafehler je Antwort. */
const MAX_ISSUES = 10;

/**
 * Höchstlänge einer Fehlermeldung in UTF-16-Einheiten. zod nennt unbekannte Schlüssel in der
 * Meldung; ohne Grenze gäbe die Antwort fast die ganze Anfrage zurück und das Audit-Log
 * speicherte sie bei jedem Aufruf mit.
 */
export const MAX_ERROR_MESSAGE_CHARS = 2_000;

export function describeIssues(error: z.ZodError): string {
  const text = error.issues
    .slice(0, MAX_ISSUES)
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
  return truncate(text, MAX_ERROR_MESSAGE_CHARS);
}

/** Kürzt auf höchstens `max` Einheiten samt „…“, ohne ein Surrogatpaar zu teilen. */
function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}
