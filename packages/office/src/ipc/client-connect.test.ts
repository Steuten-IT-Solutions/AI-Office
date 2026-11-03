import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { IpcTransportError, SupervisorClient } from "./client.ts";

/**
 * Ein Unix-Socket verbindet sofort oder scheitert sofort (`ECONNREFUSED`, `EAGAIN`). Ein
 * hängender Verbindungsaufbau lässt sich deshalb nur nachstellen: Der Socket bleibt im Zustand
 * `connecting`, und Node hält geschriebene Zeilen zurück.
 */
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createConnection: () => {
      const socket = new actual.Socket();
      (socket as Socket & { connecting: boolean }).connecting = true;
      return socket;
    },
  };
});

describe("SupervisorClient ohne Verbindungsaufbau", () => {
  it("meldet ein Zeitlimit vor dem Verbinden als sicher nicht gesendet", async () => {
    const client = new SupervisorClient({ socketPath: "/nirgends.sock", timeoutMs: 30 });
    const error: unknown = await client
      .call("office.reportHead", { seq: 1, hash: "a".repeat(64) })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IpcTransportError);
    expect(error).toMatchObject({ outcomeUnknown: false });
    expect((error as Error).message).toMatch(/keine Verbindung nach 30 ms; nichts gesendet/);
  });
});
