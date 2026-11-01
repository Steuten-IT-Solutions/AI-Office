import { createHash } from "node:crypto";
import type { RunType } from "../llm/runner.ts";

/**
 * Office-Tokens der Läufe (plan.md Kap. 4.6 „Identität eines Laufs“, E40).
 *
 * Der Supervisor stellt beim Containerstart das Office-Token aus und meldet es dem Office mit der
 * Identität des Laufs (Schnittstelle P02). Das Office prüft nur: Ein Aufruf der Office-API gilt
 * für genau den Lauf, zu dem sein Token gehört. Agent, Aufgabe und Lauftyp kommen aus dem Token,
 * nie aus den Argumenten eines Werkzeugs.
 *
 * Gespeichert wird nur der SHA-256 des Tokens, nicht das Token selbst.
 */

export interface RunGrant {
  runId: string;
  agentId: string;
  taskId: string | null;
  runType: RunType;
  /** Danach nimmt das Office das Token nicht mehr an. */
  expiresAt: Date;
}

/** Mindestlänge eines Tokens. [Annahme: 32 Zeichen, z. B. 24 Zufallsbytes in base64url] */
export const MIN_TOKEN_LENGTH = 32;

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class RunTokens {
  private readonly grants = new Map<string, RunGrant>();

  /** Meldet ein Token an. Wirft bei zu kurzen Tokens und doppelten Tokens oder Lauf-IDs. */
  register(token: string, grant: RunGrant): void {
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new Error(`Office-Token ist kürzer als ${String(MIN_TOKEN_LENGTH)} Zeichen`);
    }
    const key = digest(token);
    if (this.grants.has(key)) {
      throw new Error("Office-Token ist bereits angemeldet");
    }
    if ([...this.grants.values()].some((g) => g.runId === grant.runId)) {
      throw new Error(`Lauf ${grant.runId} hat bereits ein Office-Token`);
    }
    this.grants.set(key, { ...grant });
  }

  /** Liefert den Lauf zum Token oder `null`, wenn es unbekannt oder abgelaufen ist. */
  resolve(token: string, now: Date = new Date()): RunGrant | null {
    const grant = this.grants.get(digest(token));
    if (grant === undefined || grant.expiresAt.getTime() <= now.getTime()) {
      return null;
    }
    return { ...grant };
  }

  /** Zieht das Token eines Laufs zurück, z. B. am Laufende oder beim Notaus. */
  revoke(runId: string): void {
    for (const [key, grant] of this.grants) {
      if (grant.runId === runId) {
        this.grants.delete(key);
      }
    }
  }

  /** Entfernt abgelaufene Tokens. */
  prune(now: Date = new Date()): void {
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt.getTime() <= now.getTime()) {
        this.grants.delete(key);
      }
    }
  }
}
