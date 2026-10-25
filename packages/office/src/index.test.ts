import { describe, expect, it } from "vitest";
import { OFFICE_VERSION } from "./index.ts";

describe("office", () => {
  it("exportiert eine Versionskennung", () => {
    expect(OFFICE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
