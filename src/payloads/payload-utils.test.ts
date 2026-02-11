import { describe, it, expect } from "vitest";
import { trimOrNull, isActive, formatDate } from "./payload-utils";

describe("trimOrNull", () => {
  it("returns null for null", () => {
    expect(trimOrNull(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(trimOrNull(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(trimOrNull("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(trimOrNull("   ")).toBeNull();
  });

  it("trims and returns string", () => {
    expect(trimOrNull("  hello  ")).toBe("hello");
  });

  it("returns already-trimmed string as-is", () => {
    expect(trimOrNull("hello")).toBe("hello");
  });

  it("coerces number to string", () => {
    expect(trimOrNull(123)).toBe("123");
  });

  it("coerces boolean to string", () => {
    expect(trimOrNull(true)).toBe("true");
  });

  it("coerces zero to string", () => {
    expect(trimOrNull(0)).toBe("0");
  });

  it("coerces false to string", () => {
    expect(trimOrNull(false)).toBe("false");
  });
});

describe("isActive", () => {
  it("returns true for null (active)", () => {
    expect(isActive(null)).toBe(true);
  });

  it("returns true for undefined (active)", () => {
    expect(isActive(undefined)).toBe(true);
  });

  it("returns true for empty string (active)", () => {
    expect(isActive("")).toBe(true);
  });

  it("returns true for whitespace-only string (active)", () => {
    expect(isActive("   ")).toBe(true);
  });

  it("returns false for a date string (inactive)", () => {
    expect(isActive("2025-01-01")).toBe(false);
  });

  it("returns false for any non-empty trimmed string", () => {
    expect(isActive("something")).toBe(false);
  });

  it("returns false for a number (coerced to non-empty string)", () => {
    expect(isActive(19488)).toBe(false);
  });
});

describe("formatDate", () => {
  it("returns null for null", () => {
    expect(formatDate(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(formatDate(undefined)).toBeNull();
  });

  it("converts epoch day 0 to 1970-01-01", () => {
    expect(formatDate(0)).toBe("1970-01-01");
  });

  it("converts typical Debezium days-since-epoch", () => {
    // 19488 days * 86400000 ms = 2023-05-11
    expect(formatDate(19488)).toBe("2023-05-11");
  });

  it("converts negative epoch days", () => {
    expect(formatDate(-1)).toBe("1969-12-31");
  });

  it("converts ISO string to YYYY-MM-DD", () => {
    expect(formatDate("2025-02-11T15:30:00Z")).toBe("2025-02-11");
  });

  it("converts date-only string", () => {
    expect(formatDate("2025-02-11")).toBe("2025-02-11");
  });

  it("returns null for invalid date string", () => {
    expect(formatDate("not-a-date")).toBeNull();
  });

  it("returns null for empty string (invalid date)", () => {
    expect(formatDate("")).toBeNull();
  });
});
