import { describe, it, expect } from "vitest";
import { getAllowedTypes, CODARE_REGISTRY } from "./codare-registry";

describe("codare-registry", () => {
  describe("CODARE_REGISTRY", () => {
    it("has at least one entry", () => {
      expect(CODARE_REGISTRY.length).toBeGreaterThan(0);
    });

    it("each entry has codare and payloadTypes", () => {
      for (const entry of CODARE_REGISTRY) {
        expect(entry.codare).toBeTruthy();
        expect(entry.payloadTypes.length).toBeGreaterThan(0);
      }
    });
  });

  describe("getAllowedTypes", () => {
    it("returns supplier and contact for PRO", () => {
      const types = getAllowedTypes("PRO");
      expect(types.has("supplier")).toBe(true);
      expect(types.has("contact")).toBe(true);
      expect(types.size).toBe(2);
    });

    it("returns empty set for unknown codare", () => {
      const types = getAllowedTypes("CLI");
      expect(types.size).toBe(0);
    });

    it("returns empty set for null", () => {
      const types = getAllowedTypes(null);
      expect(types.size).toBe(0);
    });

    it("returns empty set for undefined", () => {
      const types = getAllowedTypes(undefined);
      expect(types.size).toBe(0);
    });

    it("returns empty set for empty string", () => {
      const types = getAllowedTypes("");
      expect(types.size).toBe(0);
    });

    it("trims whitespace before lookup", () => {
      const types = getAllowedTypes("  PRO  ");
      expect(types.has("supplier")).toBe(true);
      expect(types.has("contact")).toBe(true);
    });

    it("is case-sensitive (pro != PRO)", () => {
      const types = getAllowedTypes("pro");
      expect(types.size).toBe(0);
    });
  });
});
