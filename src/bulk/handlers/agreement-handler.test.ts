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

import { AgreementBulkHandler } from "./agreement-handler";
import { store } from "../../domain/store";
import { PayloadType } from "../../types/payloads";

const mockGetArray = vi.mocked(store.getArray);

const GVENACUH = { tercer: "P001", cabid: "AC001", coment: "Test", tipdoc: "VEN", fecfin: 20454, fecini: 19488, clasif: "CL001", terenv: "P001", impres: "S", indmod: "M", frmpag: "30" };

function createMockRegistry() {
  const builder = { type: "agreement" as PayloadType, build: vi.fn() };
  return {
    builder,
    registry: {
      get: vi.fn((type: PayloadType) => (type === "agreement" ? builder : undefined)),
      register: vi.fn(),
      buildAll: vi.fn(),
    },
  };
}

describe("AgreementBulkHandler", () => {
  let mocks: ReturnType<typeof createMockRegistry>;
  let handler: AgreementBulkHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMockRegistry();
    handler = new AgreementBulkHandler(mocks.registry as any);
  });

  describe("syncAll", () => {
    it("builds agreements for valid codigos", () => {
      mockGetArray.mockReturnValue([GVENACUH]);
      mocks.builder.build.mockReturnValue([
        { CodAgreement: "AC001", Agreement: "Test", CodSupplier: "P001" },
      ]);

      const result = handler.syncAll(["P001"]);

      expect(result.items).toHaveLength(1);
      expect(result.skippedDetails).toEqual([]);
    });

    it("skips when no gvenacuh records exist", () => {
      mockGetArray.mockReturnValue([]);

      const result = handler.syncAll(["P001"]);

      expect(result.items).toHaveLength(0);
      expect(result.skippedDetails).toEqual([
        { CodSupplier: "P001", reason: "No agreements found (gvenacuh)" },
      ]);
    });

    it("skips when builder returns null", () => {
      mockGetArray.mockReturnValue([GVENACUH]);
      mocks.builder.build.mockReturnValue(null);

      const result = handler.syncAll(["P001"]);

      expect(result.items).toHaveLength(0);
      expect(result.skippedDetails).toEqual([
        { CodSupplier: "P001", reason: "Builder returned null" },
      ]);
    });

    it("handles multiple codigos with mixed results", () => {
      mockGetArray.mockImplementation((_table: string, codigo: string) => {
        if (codigo === "P001") return [GVENACUH];
        return [];
      });
      mocks.builder.build.mockReturnValue([{ CodAgreement: "AC001" }]);

      const result = handler.syncAll(["P001", "P002"]);

      expect(result.items).toHaveLength(1);
      expect(result.skippedDetails).toHaveLength(1);
      expect(result.skippedDetails[0]).toEqual({
        CodSupplier: "P002",
        reason: "No agreements found (gvenacuh)",
      });
    });

    it("flattens multiple agreements from one codigo", () => {
      mockGetArray.mockReturnValue([GVENACUH, { ...GVENACUH, cabid: "AC002" }]);
      mocks.builder.build.mockReturnValue([
        { CodAgreement: "AC001" },
        { CodAgreement: "AC002" },
      ]);

      const result = handler.syncAll(["P001"]);

      expect(result.items).toHaveLength(2);
    });
  });

  describe("deleteAll", () => {
    it("builds deletion payloads for valid codigos", () => {
      mockGetArray.mockReturnValue([GVENACUH]);

      const result = handler.deleteAll(["P001"]);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual(
        expect.objectContaining({ CodAgreement: "AC001", DeletionDate: expect.any(String) })
      );
      expect(result.skippedDetails).toEqual([]);
    });

    it("skips when no gvenacuh records exist", () => {
      mockGetArray.mockReturnValue([]);

      const result = handler.deleteAll(["P001"]);

      expect(result.items).toHaveLength(0);
      expect(result.skippedDetails).toEqual([
        { CodSupplier: "P001", reason: "No agreements found (gvenacuh)" },
      ]);
    });

    it("builds deletion for each agreement record", () => {
      mockGetArray.mockReturnValue([
        GVENACUH,
        { ...GVENACUH, cabid: "AC002" },
      ]);

      const result = handler.deleteAll(["P001"]);

      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toEqual(
        expect.objectContaining({ CodAgreement: "AC001" })
      );
      expect(result.items[1]).toEqual(
        expect.objectContaining({ CodAgreement: "AC002" })
      );
    });

    it("handles multiple codigos", () => {
      mockGetArray.mockImplementation((_table: string, codigo: string) => {
        if (codigo === "P001") return [GVENACUH];
        if (codigo === "P002") return [{ ...GVENACUH, cabid: "AC003", tercer: "P002" }];
        return [];
      });

      const result = handler.deleteAll(["P001", "P002", "P003"]);

      expect(result.items).toHaveLength(2);
      expect(result.skippedDetails).toHaveLength(1);
      expect(result.skippedDetails[0].CodSupplier).toBe("P003");
    });
  });
});
