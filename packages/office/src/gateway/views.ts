import { z } from "zod";

/**
 * Daten für das Webinterface (P10), die das Office nicht selbst hat: Kontingent (S04) und offene
 * PRs (plan.md Kap. 5.11, E26). Beides liefert später der Supervisor; bis dahin bleiben die
 * Quellen leer und das Webinterface sagt das.
 *
 * Die Schemas prüfen, was das Gateway an den Browser gibt. Zahlen, Längen und das Repo-Format
 * sind begrenzt, denn der Browser baut aus Repo und Nummer den Link nach GitHub.
 */

/** `owner/name` nach den Zeichenregeln von GitHub, wie in `domain/events.ts`. */
export const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

const MAX_LABEL_CHARS = 100;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_PATH_CHARS = 300;
const MAX_PATHS = 100;
const MAX_AGENTS = 50;
/** Höchstzahl gelieferter PRs. [Annahme: mehr offene PRs prüft der CEO ohnehin nicht] */
export const MAX_PULL_REQUESTS = 200;

const isoTime = z.iso.datetime({ offset: true });
const percent = z.number().min(0).max(1000);

function text(max: number) {
  return z
    .string()
    .max(max)
    .refine((value) => value.isWellFormed(), { message: "enthält ungepaarte Surrogate" });
}

/** Ein Fenster des Kontingents (Kap. 6): Sitzung, Woche gesamt oder Woche je Modell. */
export const quotaWindowSchema = z.strictObject({
  label: text(MAX_LABEL_CHARS).min(1),
  usedPercent: percent,
  /** Schwelle, ab der das Büro pausiert (55 % Woche, 70 % 5-Stunden-Fenster), sonst `null`. */
  pauseAtPercent: percent.nullable(),
  resetsAt: isoTime.nullable(),
});

export const quotaViewSchema = z.strictObject({
  measuredAt: isoTime,
  /** Das Büro pausiert wegen des Kontingents. */
  paused: z.boolean(),
  /** Hinweis des Supervisors, z. B. „Fallback ohne /usage“ (Kap. 6). */
  note: text(MAX_SUMMARY_CHARS).nullable(),
  windows: z.array(quotaWindowSchema).max(20),
});

export type QuotaView = z.output<typeof quotaViewSchema>;

export const CI_STATES = ["success", "failure", "pending", "none"] as const;

/** Ein offener PR, wie der Supervisor ihn über die GitHub App liest (Kap. 5.11). */
export const pullRequestViewSchema = z.strictObject({
  repo: z.string().regex(REPO_PATTERN),
  number: z.int().min(1).max(1_000_000_000),
  title: text(300).min(1),
  draft: z.boolean(),
  ci: z.enum(CI_STATES),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  agentIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(MAX_AGENTS),
  /** Verbrauchte Kosten aus dem Hauptbuch, `null`, wenn unbekannt. */
  costUsd: z.number().min(0).max(1_000_000).nullable(),
  summary: text(MAX_SUMMARY_CHARS),
  /** Geänderte kritische Pfade (Kap. 5.11): werden hervorgehoben. */
  criticalPaths: z.array(text(MAX_PATH_CHARS).min(1)).max(MAX_PATHS),
  updatedAt: isoTime,
});

export type PullRequestView = z.output<typeof pullRequestViewSchema>;

export const pullRequestListSchema = z.array(pullRequestViewSchema).max(MAX_PULL_REQUESTS);

/**
 * Link zur Supervisor-Konsole (Kap. 5.11): nur `https:` ohne Zugangsdaten, sonst Fehler beim
 * Start. Der Notaus liegt dort, nicht im Office (E26).
 */
export function checkConsoleUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("consoleUrl: keine gültige URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("consoleUrl: nur https ohne Zugangsdaten");
  }
  return url.href;
}
