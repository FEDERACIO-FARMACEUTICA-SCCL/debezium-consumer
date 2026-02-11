import { describe, it, expect } from "vitest";
import { toISO2 } from "./country-codes";

describe("toISO2", () => {
  it("converts known ISO3 codes", () => {
    expect(toISO2("ESP")).toBe("ES");
    expect(toISO2("GBR")).toBe("GB");
    expect(toISO2("USA")).toBe("US");
    expect(toISO2("FRA")).toBe("FR");
    expect(toISO2("DEU")).toBe("DE");
  });

  it("converts lowercase ISO3 to uppercase ISO2", () => {
    expect(toISO2("esp")).toBe("ES");
    expect(toISO2("gbr")).toBe("GB");
  });

  it("handles mixed case with whitespace", () => {
    expect(toISO2("  eSp  ")).toBe("ES");
  });

  it("passes through ISO2 codes as-is (uppercased)", () => {
    expect(toISO2("ES")).toBe("ES");
    expect(toISO2("GB")).toBe("GB");
  });

  it("passes through lowercase ISO2 (uppercased)", () => {
    expect(toISO2("es")).toBe("ES");
  });

  it("returns null for null", () => {
    expect(toISO2(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(toISO2(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(toISO2("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(toISO2("   ")).toBeNull();
  });

  it("returns unknown 3-letter code as fallback", () => {
    expect(toISO2("XXX")).toBe("XXX");
  });

  it("returns unknown 4+ letter code as fallback", () => {
    expect(toISO2("ABCD")).toBe("ABCD");
  });
});
