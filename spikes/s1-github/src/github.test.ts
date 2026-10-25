import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppJwt } from "./github.ts";
import { firstLine } from "./git.ts";
import { hourlyShare, requestsPerCycle } from "./s1d-ratelimit.ts";

describe("createAppJwt", () => {
  it("erzeugt ein gültig signiertes RS256-JWT mit iss, iat und exp", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = createAppJwt("12345", privateKey, 1_000_000);
    const [header, payload, signature] = jwt.split(".");
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();
    const valid = verify(
      "RSA-SHA256",
      Buffer.from(`${String(header)}.${String(payload)}`),
      publicKey,
      Buffer.from(String(signature), "base64url"),
    );
    expect(valid).toBe(true);
    expect(JSON.parse(Buffer.from(String(payload), "base64url").toString())).toEqual({
      iat: 999_940,
      exp: 1_000_540,
      iss: "12345",
    });
  });
});

describe("firstLine", () => {
  it("maskiert Zugangsdaten in Git-Ausgaben", () => {
    const line = firstLine("error: https://x-access-token:geheim@github.com/o/r.git abgelehnt");
    expect(line).not.toContain("geheim");
    expect(line).toContain("x-access-token:***");
  });
});

describe("Hochrechnung S1d", () => {
  it("rechnet 1 + 2 Anfragen je offenem PR", () => {
    expect(requestsPerCycle(10)).toBe(21);
  });

  it("berechnet den Anteil am Stundenlimit", () => {
    expect(hourlyShare(21, 60, 5000)).toBeCloseTo(0.252);
  });
});
