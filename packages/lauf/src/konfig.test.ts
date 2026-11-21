import { describe, expect, it } from "vitest";
import { KonfigFehler, leseKonfig, MAX_LEASE_SEKUNDEN } from "./konfig.ts";

const BASIS = {
  AIO_LAUF_ID: "r-7f3a9c",
  AIO_LEASE_SEKUNDEN: "1800",
};
const SHA = "a".repeat(40);

describe("leseKonfig", () => {
  it("liest einen Büro-Lauf ohne Arbeitskopie mit Standardwerten", () => {
    const konfig = leseKonfig(BASIS, ["claude", "-p", "--model", "haiku"]);
    expect(konfig).toEqual({
      laufId: "r-7f3a9c",
      leaseMs: 1_800_000,
      stoppStufeMs: 10_000,
      ausgabe: "/aio/ausgabe",
      bundle: null,
      befehl: "claude",
      argumente: ["-p", "--model", "haiku"],
    });
  });

  it("liest einen Werkbank-Lauf mit Bundle", () => {
    const konfig = leseKonfig(
      {
        ...BASIS,
        AIO_ARBEITSKOPIE: "/work/repo",
        AIO_BUNDLE_REF: "refs/heads/agent/r-7f3a9c",
        AIO_BUNDLE_BASIS: SHA,
        AIO_BUNDLE_SEKUNDEN: "30",
        AIO_STOPP_STUFE_SEKUNDEN: "5",
        AIO_AUSGABE: "/aio/aus",
      },
      ["claude"],
    );
    expect(konfig.bundle).toEqual({
      arbeitskopie: "/work/repo",
      ref: "refs/heads/agent/r-7f3a9c",
      basis: SHA,
      timeoutMs: 30_000,
    });
    expect(konfig.stoppStufeMs).toBe(5000);
    expect(konfig.ausgabe).toBe("/aio/aus");
  });

  it.each([
    ["ohne Lauf-ID", { AIO_LEASE_SEKUNDEN: "10" }],
    ["mit ungültiger Lauf-ID", { ...BASIS, AIO_LAUF_ID: "../x" }],
    ["ohne Lease", { AIO_LAUF_ID: "r-1" }],
    ["mit Lease 0", { ...BASIS, AIO_LEASE_SEKUNDEN: "0" }],
    ["mit negativer Lease", { ...BASIS, AIO_LEASE_SEKUNDEN: "-5" }],
    ["mit Lease als Kommazahl", { ...BASIS, AIO_LEASE_SEKUNDEN: "1.5" }],
    ["mit zu langer Lease", { ...BASIS, AIO_LEASE_SEKUNDEN: String(MAX_LEASE_SEKUNDEN + 1) }],
    ["mit zu langer Stop-Stufe", { ...BASIS, AIO_STOPP_STUFE_SEKUNDEN: "121" }],
    ["mit relativer Ausgabe", { ...BASIS, AIO_AUSGABE: "aus" }],
    ["mit .. in der Ausgabe", { ...BASIS, AIO_AUSGABE: "/aio/../etc" }],
    ["mit Arbeitskopie ohne Ref", { ...BASIS, AIO_ARBEITSKOPIE: "/work/repo" }],
    [
      "mit Ref außerhalb von agent/",
      { ...BASIS, AIO_ARBEITSKOPIE: "/work/repo", AIO_BUNDLE_REF: "refs/heads/main" },
    ],
    [
      "mit Ref auf Unterordner",
      { ...BASIS, AIO_ARBEITSKOPIE: "/work/repo", AIO_BUNDLE_REF: "refs/heads/agent/a/b" },
    ],
    [
      "mit kurzer Basis",
      {
        ...BASIS,
        AIO_ARBEITSKOPIE: "/work/repo",
        AIO_BUNDLE_REF: "refs/heads/agent/r-1",
        AIO_BUNDLE_BASIS: "abc123",
      },
    ],
    ["mit Ref ohne Arbeitskopie", { ...BASIS, AIO_BUNDLE_REF: "refs/heads/agent/r-1" }],
  ])("lehnt eine Konfiguration %s ab", (_name, env) => {
    expect(() => leseKonfig(env, ["claude"])).toThrow(KonfigFehler);
  });

  it("verlangt einen Befehl", () => {
    expect(() => leseKonfig(BASIS, [])).toThrow(KonfigFehler);
  });
});
