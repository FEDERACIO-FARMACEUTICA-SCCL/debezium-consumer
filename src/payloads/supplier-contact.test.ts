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
  const getArray = vi.fn();
  return {
    store: { getSingle, getArray, getAllCodigos: vi.fn() },
  };
});

import { SupplierContactBuilder } from "./supplier-contact";
import { store } from "../domain/store";

const mockGetSingle = vi.mocked(store.getSingle);
const mockGetArray = vi.mocked(store.getArray);

const CTERCERO = { codigo: "P001", nombre: "Acme Corp", cif: "B12345678" };
const GPROVEED = { codigo: "P001", fecalt: 19488, fecbaj: null };
const DIR1 = {
  codigo: "P001",
  direcc: "Calle Mayor 1",
  poblac: "Madrid",
  codnac: "ESP",
  codpos: "28001",
  telef1: "911234567",
  email: "info@acme.es",
};

describe("SupplierContactBuilder", () => {
  let builder: SupplierContactBuilder;

  beforeEach(() => {
    vi.clearAllMocks();
    builder = new SupplierContactBuilder();
  });

  it("has type 'contact'", () => {
    expect(builder.type).toBe("contact");
  });

  it("builds successful contact with 1 address", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero") return CTERCERO;
      if (table === "gproveed") return GPROVEED;
      return undefined;
    });
    mockGetArray.mockReturnValue([DIR1]);

    const result = builder.build("P001");

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      CodSupplier: "P001",
      Name: "Acme Corp",
      NIF: "B12345678",
      Adress: "Calle Mayor 1",
      City: "Madrid",
      Country: "ES",
      Postal_Code: "28001",
      Phone: "911234567",
      E_Mail: "info@acme.es",
      Status: "ACTIVE",
    });
  });

  it("builds multiple contacts for multiple addresses", () => {
    const dir2 = {
      codigo: "P001",
      direcc: "Av. Diagonal 100",
      poblac: "Barcelona",
      codnac: "ESP",
      codpos: "08028",
      telef1: "932222222",
      email: "bcn@acme.es",
    };
    const dir3 = {
      codigo: "P001",
      direcc: "Gran Via 50",
      poblac: "Valencia",
      codnac: "ESP",
      codpos: "46001",
      telef1: null,
      email: null,
    };

    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero") return CTERCERO;
      if (table === "gproveed") return GPROVEED;
      return undefined;
    });
    mockGetArray.mockReturnValue([DIR1, dir2, dir3]);

    const result = builder.build("P001");

    expect(result).toHaveLength(3);
    // All share same CodSupplier and Name
    for (const contact of result!) {
      expect(contact.CodSupplier).toBe("P001");
      expect(contact.Name).toBe("Acme Corp");
    }
    expect(result![1].City).toBe("Barcelona");
    expect(result![2].Phone).toBeNull();
  });

  it("returns null when ctercero is missing", () => {
    mockGetSingle.mockImplementation(() => undefined);
    mockGetArray.mockReturnValue([DIR1]);

    expect(builder.build("P001")).toBeNull();
  });

  it("returns null when gproveed is missing", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero") return CTERCERO;
      return undefined;
    });
    mockGetArray.mockReturnValue([DIR1]);

    expect(builder.build("P001")).toBeNull();
  });

  it("returns null when no addresses exist", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero") return CTERCERO;
      if (table === "gproveed") return GPROVEED;
      return undefined;
    });
    mockGetArray.mockReturnValue([]);

    expect(builder.build("P001")).toBeNull();
  });

  it("converts ISO3 country to ISO2", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero") return CTERCERO;
      if (table === "gproveed") return GPROVEED;
      return undefined;
    });
    mockGetArray.mockReturnValue([{ ...DIR1, codnac: "GBR" }]);

    expect(builder.build("P001")![0].Country).toBe("GB");
  });

  it("returns Country null when codnac is null", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero") return CTERCERO;
      if (table === "gproveed") return GPROVEED;
      return undefined;
    });
    mockGetArray.mockReturnValue([{ ...DIR1, codnac: null }]);

    expect(builder.build("P001")![0].Country).toBeNull();
  });

  it("returns null for all address fields when they are null", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero") return CTERCERO;
      if (table === "gproveed") return GPROVEED;
      return undefined;
    });
    mockGetArray.mockReturnValue([
      {
        codigo: "P001",
        direcc: null,
        poblac: null,
        codnac: null,
        codpos: null,
        telef1: null,
        email: null,
      },
    ]);

    const contact = builder.build("P001")![0];
    expect(contact.Adress).toBeNull();
    expect(contact.City).toBeNull();
    expect(contact.Country).toBeNull();
    expect(contact.Postal_Code).toBeNull();
    expect(contact.Phone).toBeNull();
    expect(contact.E_Mail).toBeNull();
  });

  it("returns ACTIVE status when fecbaj is null", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero") return CTERCERO;
      if (table === "gproveed") return { ...GPROVEED, fecbaj: null };
      return undefined;
    });
    mockGetArray.mockReturnValue([DIR1]);

    expect(builder.build("P001")![0].Status).toBe("ACTIVE");
  });

  it("returns INACTIVE status when fecbaj has value", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero") return CTERCERO;
      if (table === "gproveed") return { ...GPROVEED, fecbaj: 19500 };
      return undefined;
    });
    mockGetArray.mockReturnValue([DIR1]);

    const result = builder.build("P001");
    expect(result![0].Status).toBe("INACTIVE");
  });

  it("applies same status to all contacts", () => {
    mockGetSingle.mockImplementation((table: string) => {
      if (table === "ctercero") return CTERCERO;
      if (table === "gproveed") return { ...GPROVEED, fecbaj: 19500 };
      return undefined;
    });
    mockGetArray.mockReturnValue([DIR1, { ...DIR1, direcc: "Other" }]);

    const result = builder.build("P001")!;
    expect(result).toHaveLength(2);
    expect(result[0].Status).toBe("INACTIVE");
    expect(result[1].Status).toBe("INACTIVE");
  });
});
