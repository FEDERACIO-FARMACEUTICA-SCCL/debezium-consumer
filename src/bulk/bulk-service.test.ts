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
  const getAllCodigos = vi.fn();
  return {
    store: { getSingle, getArray, getAllCodigos },
  };
});

import { BulkService, BulkOperationInProgressError } from "./bulk-service";
import { store } from "../domain/store";
import { PayloadType } from "../types/payloads";

const mockGetSingle = vi.mocked(store.getSingle);
const mockGetArray = vi.mocked(store.getArray);
const mockGetAllCodigos = vi.mocked(store.getAllCodigos);

function createMockClient() {
  return {
    request: vi.fn().mockResolvedValue(undefined),
    authenticate: vi.fn(),
  };
}

function createMockRegistry() {
  const supplierBuilder = {
    type: "supplier" as PayloadType,
    build: vi.fn(),
  };
  const contactBuilder = {
    type: "contact" as PayloadType,
    build: vi.fn(),
  };
  return {
    supplierBuilder,
    contactBuilder,
    registry: {
      get: vi.fn((type: PayloadType) => {
        if (type === "supplier") return supplierBuilder;
        if (type === "contact") return contactBuilder;
        return undefined;
      }),
      register: vi.fn(),
      buildAll: vi.fn(),
    },
  };
}

const CTERCERO = { codigo: "P001", nombre: "Acme", cif: "B12345" };
const GPROVEED = { codigo: "P001", fecalt: 19488, fecbaj: null };

describe("BulkService", () => {
  let client: ReturnType<typeof createMockClient>;
  let mocks: ReturnType<typeof createMockRegistry>;
  let service: BulkService;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createMockClient();
    mocks = createMockRegistry();
    service = new BulkService(client as any, mocks.registry as any, 10);
  });

  describe("syncSuppliers", () => {
    it("happy path — builds and sends suppliers", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });
      mocks.supplierBuilder.build.mockReturnValue([
        { CodSupplier: "P001", Supplier: "Acme", NIF: "B12345", StartDate: "2023-05-10", Status: "ACTIVE" },
      ]);

      const result = await service.syncSuppliers();

      expect(result.operation).toBe("sync");
      expect(result.target).toBe("supplier");
      expect(result.totalCodsuppliers).toBe(1);
      expect(result.totalItems).toBe(1);
      expect(result.successBatches).toBe(1);
      expect(result.failedBatches).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.skippedDetails).toEqual([]);
      expect(client.request).toHaveBeenCalledWith("PUT", "/ingest-api/suppliers", expect.any(Array));
    });

    it("skips codigo when ctercero is missing", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockReturnValue(undefined);

      const result = await service.syncSuppliers();

      expect(result.skipped).toBe(1);
      expect(result.skippedDetails).toEqual([
        { CodSupplier: "P001", reason: "Not found in store (ctercero)" },
      ]);
      expect(result.totalItems).toBe(0);
    });

    it("skips codigo when gproveed is missing", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        return undefined;
      });

      const result = await service.syncSuppliers();

      expect(result.skipped).toBe(1);
      expect(result.skippedDetails[0].reason).toBe("Incomplete data: missing gproveed");
    });

    it("skips when builder returns null", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });
      mocks.supplierBuilder.build.mockReturnValue(null);

      const result = await service.syncSuppliers();

      expect(result.skipped).toBe(1);
      expect(result.skippedDetails[0].reason).toBe("Builder returned null");
    });

    it("filters by explicit codigos", async () => {
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });
      mocks.supplierBuilder.build.mockReturnValue([{ CodSupplier: "P001" }]);

      const result = await service.syncSuppliers(["P001"]);

      expect(result.totalCodsuppliers).toBe(1);
      expect(mockGetAllCodigos).not.toHaveBeenCalled();
    });

    it("handles empty codigos array", async () => {
      const result = await service.syncSuppliers([]);

      expect(result.totalCodsuppliers).toBe(0);
      expect(result.totalItems).toBe(0);
      expect(client.request).not.toHaveBeenCalled();
    });
  });

  describe("syncContacts", () => {
    it("happy path — builds and sends contacts", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });
      mockGetArray.mockReturnValue([{ codigo: "P001", direcc: "Calle 1" }]);
      mocks.contactBuilder.build.mockReturnValue([
        { CodSupplier: "P001", Name: "Acme" },
      ]);

      const result = await service.syncContacts();

      expect(result.operation).toBe("sync");
      expect(result.target).toBe("contact");
      expect(result.totalItems).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it("skips when no addresses exist", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });
      mockGetArray.mockReturnValue([]);

      const result = await service.syncContacts();

      expect(result.skipped).toBe(1);
      expect(result.skippedDetails[0].reason).toBe("No addresses found (cterdire)");
    });

    it("skips when builder returns null", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });
      mockGetArray.mockReturnValue([{ codigo: "P001", direcc: "X" }]);
      mocks.contactBuilder.build.mockReturnValue(null);

      const result = await service.syncContacts();

      expect(result.skipped).toBe(1);
      expect(result.skippedDetails[0].reason).toBe("Builder returned null");
    });
  });

  describe("deleteSuppliers", () => {
    it("happy path — builds deletion payloads", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        return undefined;
      });

      const result = await service.deleteSuppliers();

      expect(result.operation).toBe("delete");
      expect(result.target).toBe("supplier");
      expect(result.totalItems).toBe(1);
      expect(client.request).toHaveBeenCalledWith(
        "DELETE",
        "/ingest-api/suppliers",
        expect.arrayContaining([
          expect.objectContaining({ CodSupplier: "P001", DeletionDate: expect.any(String) }),
        ])
      );
    });

    it("skips when ctercero is missing", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockReturnValue(undefined);

      const result = await service.deleteSuppliers();

      expect(result.skipped).toBe(1);
      expect(result.skippedDetails[0].reason).toBe("Not found in store (ctercero)");
    });
  });

  describe("deleteContacts", () => {
    it("happy path — builds deletion payloads with NIF", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        return undefined;
      });

      const result = await service.deleteContacts();

      expect(result.operation).toBe("delete");
      expect(result.target).toBe("contact");
      expect(result.totalItems).toBe(1);
      expect(client.request).toHaveBeenCalledWith(
        "DELETE",
        "/ingest-api/suppliers-contacts",
        expect.arrayContaining([
          expect.objectContaining({ CodSupplier: "P001", NIF: "B12345" }),
        ])
      );
    });

    it("skips when ctercero is missing", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockReturnValue(undefined);

      const result = await service.deleteContacts();

      expect(result.skipped).toBe(1);
      expect(result.skippedDetails[0].reason).toBe("Not found in store (ctercero)");
    });

    it("skips when NIF is null", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return { ...CTERCERO, cif: null };
        return undefined;
      });

      const result = await service.deleteContacts();

      expect(result.skipped).toBe(1);
      expect(result.skippedDetails[0].reason).toBe("Missing NIF (cif)");
    });

    it("skips when NIF is empty string", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return { ...CTERCERO, cif: "  " };
        return undefined;
      });

      const result = await service.deleteContacts();

      expect(result.skipped).toBe(1);
      expect(result.skippedDetails[0].reason).toBe("Missing NIF (cif)");
    });
  });

  describe("batching", () => {
    it("chunks items into correct batch sizes", async () => {
      const codigos = Array.from({ length: 25 }, (_, i) => `P${String(i).padStart(3, "0")}`);
      mockGetAllCodigos.mockReturnValue(codigos);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });
      mocks.supplierBuilder.build.mockReturnValue([{ CodSupplier: "X" }]);

      const result = await service.syncSuppliers();

      // 25 items / batchSize 10 = 3 batches
      expect(result.batches).toBe(3);
      expect(result.successBatches).toBe(3);
      expect(client.request).toHaveBeenCalledTimes(3);
    });

    it("counts failed batches correctly", async () => {
      const codigos = Array.from({ length: 25 }, (_, i) => `P${String(i).padStart(3, "0")}`);
      mockGetAllCodigos.mockReturnValue(codigos);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });
      mocks.supplierBuilder.build.mockReturnValue([{ CodSupplier: "X" }]);

      let callCount = 0;
      client.request.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error("Batch 2 failed");
      });

      const result = await service.syncSuppliers();

      expect(result.batches).toBe(3);
      expect(result.successBatches).toBe(2);
      expect(result.failedBatches).toBe(1);
    });
  });

  describe("mutex", () => {
    it("throws BulkOperationInProgressError on concurrent calls", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });
      mocks.supplierBuilder.build.mockReturnValue([{ CodSupplier: "P001" }]);

      // Make first call hang
      let resolveRequest: (() => void) | undefined;
      client.request.mockImplementation(
        () => new Promise<void>((resolve) => { resolveRequest = resolve; })
      );

      const first = service.syncSuppliers();
      // Wait for microtask so first enters withMutex
      await new Promise((r) => setTimeout(r, 0));

      await expect(service.syncSuppliers()).rejects.toThrow(
        BulkOperationInProgressError
      );

      // Cleanup
      resolveRequest!();
      await first;
    });

    it("allows sequential calls after first completes", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });
      mocks.supplierBuilder.build.mockReturnValue([{ CodSupplier: "P001" }]);

      await service.syncSuppliers();
      const result2 = await service.syncSuppliers();

      expect(result2.totalItems).toBe(1);
    });
  });

  describe("BulkResult shape", () => {
    it("contains all required fields", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });
      mocks.supplierBuilder.build.mockReturnValue([{ CodSupplier: "P001" }]);

      const result = await service.syncSuppliers();

      expect(result).toEqual(
        expect.objectContaining({
          operation: "sync",
          target: "supplier",
          totalCodsuppliers: expect.any(Number),
          totalItems: expect.any(Number),
          batches: expect.any(Number),
          successBatches: expect.any(Number),
          failedBatches: expect.any(Number),
          skipped: expect.any(Number),
          skippedDetails: expect.any(Array),
          durationMs: expect.any(Number),
        })
      );
    });
  });

  describe("skippedDetails", () => {
    it("includes CodSupplier and reason for each skip", async () => {
      mockGetAllCodigos.mockReturnValue(["P001", "P002", "P003"]);
      mockGetSingle.mockImplementation((table: string, codigo: string) => {
        if (table === "ctercero" && codigo === "P001") return CTERCERO;
        if (table === "ctercero" && codigo === "P002") return { ...CTERCERO, codigo: "P002" };
        if (table === "gproveed" && codigo === "P001") return GPROVEED;
        // P002: no gproveed; P003: no ctercero
        return undefined;
      });
      mocks.supplierBuilder.build.mockReturnValue([{ CodSupplier: "P001" }]);

      const result = await service.syncSuppliers();

      expect(result.skipped).toBe(2);
      expect(result.skippedDetails).toEqual(
        expect.arrayContaining([
          { CodSupplier: "P002", reason: "Incomplete data: missing gproveed" },
          { CodSupplier: "P003", reason: "Not found in store (ctercero)" },
        ])
      );
    });
  });

  describe("filter codigos", () => {
    it("uses provided codigos instead of store", async () => {
      mockGetSingle.mockImplementation((table: string) => {
        if (table === "ctercero") return CTERCERO;
        if (table === "gproveed") return GPROVEED;
        return undefined;
      });
      mocks.supplierBuilder.build.mockReturnValue([{ CodSupplier: "P001" }]);

      const result = await service.syncSuppliers(["P001"]);

      expect(result.totalCodsuppliers).toBe(1);
      expect(mockGetAllCodigos).not.toHaveBeenCalled();
    });

    it("falls back to all codigos when undefined", async () => {
      mockGetAllCodigos.mockReturnValue(["P001", "P002"]);
      mockGetSingle.mockReturnValue(undefined);

      const result = await service.syncSuppliers();

      expect(mockGetAllCodigos).toHaveBeenCalledWith("ctercero");
      expect(result.totalCodsuppliers).toBe(2);
    });
  });
});
