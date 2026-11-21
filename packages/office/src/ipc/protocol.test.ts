import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IPC_METHODS,
  METHODS,
  PROTOCOL_VERSION,
  SCHEMA_LOCALE,
  describeIssues,
} from "./protocol.ts";

/**
 * SHA-256 von `packages/supervisor/src/ipc/protocol.ts` im Supervisor-Repo, Stand e24f278 (S08).
 * Das Repo ist privat, die CI hier kann es nicht lesen; der Hash hält die Kopie trotzdem fest.
 * Neue Protokollversion: Datei im Supervisor ändern, hierher kopieren, Hash und Stand anpassen.
 */
const SUPERVISOR_PROTOCOL_SHA256 =
  "494ec150aee3712ef52ad952685d1d21b122b2da3c61f8be5464ab9422042e22";

describe("Kopie des Protokolls aus S02, S05 und S08", () => {
  it("ist unterhalb des Kopfkommentars unverändert", () => {
    const source = readFileSync(new URL("protocol.ts", import.meta.url), "utf8");
    const start = source.indexOf('import { z } from "zod";');
    expect(start).toBeGreaterThan(0);
    const hash = createHash("sha256").update(source.slice(start), "utf8").digest("hex");
    expect(hash).toBe(SUPERVISOR_PROTOCOL_SHA256);
  });

  it("spricht Version 1 mit den fünf Methoden aus Kap. 4.6 den zwei aus S05 und den zwei aus S08", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(IPC_METHODS).toEqual([
      "run.request",
      "profile.check",
      "workplaces.change",
      "escalation.checkToCeo",
      "office.reportHead",
      "run.token",
      "run.output",
      "git.status",
      "fingerprints.add",
    ]);
    const parsed = METHODS["run.request"].params.safeParse(
      {
        agentId: "cto",
        runType: "buero",
        taskId: null,
        repo: "Steuten-IT-Solutions/AI-Office",
        model: "sonnet",
        prompt: "x",
      },
      { error: SCHEMA_LOCALE },
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(describeIssues(parsed.error)).toMatch(/repo: .*werkbank/);
    }
  });
});
