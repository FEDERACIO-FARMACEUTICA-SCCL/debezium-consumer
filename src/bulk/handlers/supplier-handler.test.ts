import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logger", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../domain/store", () => {
  const getSingle = vi.fn();
  const getArray = vi.fn();
  const getAllCodigos = vi.fn();
  return { store: { getSingle, getArray, getAllCodigos } };
});

import { SupplierBulkHandler } from "./supplier-handler";
import { store } from "../../domain/store";
import { PayloadType } from "../../types/payloads";

const mockGetSingle = vi.mocked(store.getSingle);

const CTERCERO = { codigo: "P001", nombre: "Acme", cif: "B12345", codare: "PRO" };
const GPROVEED = { codigo: "P001", fecalt: 19488, fecbaj: null };

function createMockRegistry() {
  const builder = { type: "supplier" as PayloadType, build: vi.fn() };
  return {
    builder,
    registry: {
      get: vi.fn((type: PayloadType) => (type === "supplier" ? builder : undefined)),
      register: vi.fn(),
      buildAll: vi.fn(),
    },
  };
}

describe("SupplierBulkHandler", () => {
  let mocks: ReturnType<typeof createMockRegistry>;
  let handler: SupplierBulkHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMockRegistry();
    handler = new SupplierBulkHandler(mocks.registry as any);
  });

  describe("syncAll", () => {
    it("builds suppliers for valid codigos", () => {
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });
      mocks.builder.build.mockReturnValue([
        { CodSupplier: "P001", Supplier: "Acme", NIF: "B12345", StartDate: "2023-05-10", Status: "ACTIVE" },
      ]);

      const result = handler.syncAll(["P001"]);

      expect(result.items).toHaveLength(1);
      expect(result.skippedDetails).toEqual([]);
    });

    it("skips when ctercero is missing", () => {
      mockGetSingle.mockReturnValue(undefined);

      const result = handler.syncAll(["P001"]);

      expect(result.items).toHaveLength(0);
      expect(result.skippedDetails).toEqual([
        { CodSupplier: "P001", reason: "Not found in store (ctercero)" },
      ]);
    });

    it("skips when gproveed is missing", () => {
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        return undefined;
      });

      const result = handler.syncAll(["P001"]);

      expect(result.skippedDetails[0].reason).toBe("Incomplete data: missing gproveed");
    });

    it("skips when builder returns null", () => {
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });
      mocks.builder.build.mockReturnValue(null);

      const result = handler.syncAll(["P001"]);

      expect(result.skippedDetails[0].reason).toBe("Builder returned null");
    });

    it("handles multiple codigos with mixed results", () => {
      mockGetSingle.mockImplementation((table: string, codigo: string) => {
        if (table === "ctercero" && codigo === "P001") return CTERCERO;
        if (table === "ctercero" && codigo === "P002") return { ...CTERCERO, codigo: "P002" };
        if (table === "gproveed" && codigo === "P001") return GPROVEED;
        return undefined;
      });
      mocks.builder.build.mockReturnValue([{ CodSupplier: "P001" }]);

      const result = handler.syncAll(["P001", "P002", "P003"]);

      expect(result.items).toHaveLength(1);
      expect(result.skippedDetails).toHaveLength(2);
    });

    it("skips when codare is not applicable (e.g. CLI)", () => {
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return { ...CTERCERO, codare: "CLI" };
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });

      const result = handler.syncAll(["P001"]);

      expect(result.items).toHaveLength(0);
      expect(result.skippedDetails).toEqual([
        { CodSupplier: "P001", reason: "codare 'CLI' not applicable" },
      ]);
    });

    it("skips when codare is null", () => {
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return { ...CTERCERO, codare: null };
        return undefined;
      });

      const result = handler.syncAll(["P001"]);

      expect(result.items).toHaveLength(0);
      expect(result.skippedDetails[0].reason).toBe("codare '' not applicable");
    });
  });

  describe("deleteAll", () => {
    it("builds deletion payloads for valid codigos", () => {
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        return undefined;
      });

      const result = handler.deleteAll(["P001"]);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual(
        expect.objectContaining({ CodSupplier: "P001", DeletionDate: expect.any(String) })
      );
      expect(result.skippedDetails).toEqual([]);
    });

    it("skips when ctercero is missing", () => {
      mockGetSingle.mockReturnValue(undefined);

      const result = handler.deleteAll(["P001"]);

      expect(result.items).toHaveLength(0);
      expect(result.skippedDetails).toEqual([
        { CodSupplier: "P001", reason: "Not found in store (ctercero)" },
      ]);
    });

    it("skips when codare is not applicable", () => {
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return { ...CTERCERO, codare: "LAB" };
        return undefined;
      });

      const result = handler.deleteAll(["P001"]);

      expect(result.items).toHaveLength(0);
      expect(result.skippedDetails).toEqual([
        { CodSupplier: "P001", reason: "codare 'LAB' not applicable" },
      ]);
    });
  });
});
