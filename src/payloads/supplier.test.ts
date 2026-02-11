import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../domain/store", () => {
  const getSingle = vi.fn();
  return {
    store: { getSingle, getArray: vi.fn(), getAllCodigos: vi.fn() },
  };
});

import { SupplierBuilder } from "./supplier";
import { store } from "../domain/store";

const mockGetSingle = vi.mocked(store.getSingle);

describe("SupplierBuilder", () => {
  let builder: SupplierBuilder;

  beforeEach(() => {
    vi.clearAllMocks();
    builder = new SupplierBuilder();
  });

  it("has type 'supplier'", () => {
    expect(builder.type).toBe("supplier");
  });

  it("builds successful supplier payload", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero")
        return { codigo: "P001", nombre: "Acme Corp", cif: "B12345678" };
      if (table === "gproveed")
        return { codigo: "P001", fecalt: 19488, fecbaj: null };
      return undefined;
    });

    const result = builder.build("P001");

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      CodSupplier: "P001",
      Supplier: "Acme Corp",
      NIF: "B12345678",
      StartDate: "2023-05-11",
      Status: "ACTIVE",
    });
  });

  it("returns null when ctercero is missing", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "gproveed") return { codigo: "P001", fecalt: 19488 };
      return undefined;
    });

    expect(builder.build("P001")).toBeNull();
  });

  it("returns null when gproveed is missing", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero")
        return { codigo: "P001", nombre: "Acme", cif: "X" };
      return undefined;
    });

    expect(builder.build("P001")).toBeNull();
  });

  it("returns ACTIVE status when fecbaj is null", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero")
        return { codigo: "P001", nombre: "X", cif: "Y" };
      if (table === "gproveed")
        return { codigo: "P001", fecalt: 100, fecbaj: null };
      return undefined;
    });

    expect(builder.build("P001")![0].Status).toBe("ACTIVE");
  });

  it("returns ACTIVE status when fecbaj is empty string", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero")
        return { codigo: "P001", nombre: "X", cif: "Y" };
      if (table === "gproveed")
        return { codigo: "P001", fecalt: 100, fecbaj: "" };
      return undefined;
    });

    expect(builder.build("P001")![0].Status).toBe("ACTIVE");
  });

  it("returns INACTIVE status when fecbaj has a value", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero")
        return { codigo: "P001", nombre: "X", cif: "Y" };
      if (table === "gproveed")
        return { codigo: "P001", fecalt: 100, fecbaj: 19500 };
      return undefined;
    });

    expect(builder.build("P001")![0].Status).toBe("INACTIVE");
  });

  it("returns NIF null when cif is empty", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero")
        return { codigo: "P001", nombre: "X", cif: "" };
      if (table === "gproveed")
        return { codigo: "P001", fecalt: 100, fecbaj: null };
      return undefined;
    });

    expect(builder.build("P001")![0].NIF).toBeNull();
  });

  it("trims nombre whitespace", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero")
        return { codigo: "P001", nombre: "  Acme  ", cif: "X" };
      if (table === "gproveed")
        return { codigo: "P001", fecalt: 100, fecbaj: null };
      return undefined;
    });

    expect(builder.build("P001")![0].Supplier).toBe("Acme");
  });

  it("returns StartDate null when fecalt is null", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero")
        return { codigo: "P001", nombre: "X", cif: "Y" };
      if (table === "gproveed")
        return { codigo: "P001", fecalt: null, fecbaj: null };
      return undefined;
    });

    expect(builder.build("P001")![0].StartDate).toBeNull();
  });

  it("formats StartDate from epoch days", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero")
        return { codigo: "P001", nombre: "X", cif: "Y" };
      if (table === "gproveed")
        return { codigo: "P001", fecalt: 19488, fecbaj: null };
      return undefined;
    });

    expect(builder.build("P001")![0].StartDate).toBe("2023-05-11");
  });
});
