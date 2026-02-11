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

vi.mock("../domain/entity-registry", () => ({
  ENTITY_MAP: new Map([
    ["supplier", { type: "supplier", label: "Supplier", triggerPath: "suppliers", apiPath: "/ingest-api/suppliers", swagger: {} }],
    ["contact", { type: "contact", label: "SupplierContact", triggerPath: "contacts", apiPath: "/ingest-api/suppliers-contacts", swagger: {} }],
  ]),
  ENTITY_LABELS: { supplier: "Supplier", contact: "SupplierContact" },
  ENTITY_ENDPOINTS: { supplier: "/ingest-api/suppliers", contact: "/ingest-api/suppliers-contacts" },
}));

import { BulkService, BulkOperationInProgressError } from "./bulk-service";
import { store } from "../domain/store";
import { PayloadType } from "../types/payloads";
import { BulkHandler } from "./bulk-handler";

const mockGetAllCodigos = vi.mocked(store.getAllCodigos);

function createMockClient() {
  return {
    request: vi.fn().mockResolvedValue(undefined),
    authenticate: vi.fn(),
  };
}

function createMockHandler(type: PayloadType): BulkHandler & { syncAll: ReturnType<typeof vi.fn>; deleteAll: ReturnType<typeof vi.fn> } {
  return {
    type,
    syncAll: vi.fn().mockReturnValue({ items: [], skippedDetails: [] }),
    deleteAll: vi.fn().mockReturnValue({ items: [], skippedDetails: [] }),
  };
}

describe("BulkService", () => {
  let client: ReturnType<typeof createMockClient>;
  let supplierHandler: ReturnType<typeof createMockHandler>;
  let contactHandler: ReturnType<typeof createMockHandler>;
  let service: BulkService;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createMockClient();
    supplierHandler = createMockHandler("supplier");
    contactHandler = createMockHandler("contact");
    service = new BulkService(client as any, 10);
    service.registerHandler(supplierHandler);
    service.registerHandler(contactHandler);
  });

  describe("sync", () => {
    it("happy path — delegates to handler and sends batches", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      supplierHandler.syncAll.mockReturnValue({
        items: [{ CodSupplier: "P001", Supplier: "Acme" }],
        skippedDetails: [],
      });

      const result = await service.sync("supplier");

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

    it("passes skippedDetails from handler", async () => {
      mockGetAllCodigos.mockReturnValue(["P001", "P002"]);
      supplierHandler.syncAll.mockReturnValue({
        items: [{ CodSupplier: "P001" }],
        skippedDetails: [{ CodSupplier: "P002", reason: "Not found in store (ctercero)" }],
      });

      const result = await service.sync("supplier");

      expect(result.skipped).toBe(1);
      expect(result.skippedDetails).toEqual([
        { CodSupplier: "P002", reason: "Not found in store (ctercero)" },
      ]);
    });

    it("filters by explicit codigos", async () => {
      supplierHandler.syncAll.mockReturnValue({ items: [{ CodSupplier: "P001" }], skippedDetails: [] });

      const result = await service.sync("supplier", ["P001"]);

      expect(result.totalCodsuppliers).toBe(1);
      expect(mockGetAllCodigos).not.toHaveBeenCalled();
      expect(supplierHandler.syncAll).toHaveBeenCalledWith(["P001"]);
    });

    it("falls back to all codigos when undefined", async () => {
      mockGetAllCodigos.mockReturnValue(["P001", "P002"]);
      supplierHandler.syncAll.mockReturnValue({ items: [], skippedDetails: [] });

      const result = await service.sync("supplier");

      expect(mockGetAllCodigos).toHaveBeenCalledWith("ctercero");
      expect(result.totalCodsuppliers).toBe(2);
    });

    it("handles empty codigos array", async () => {
      supplierHandler.syncAll.mockReturnValue({ items: [], skippedDetails: [] });

      const result = await service.sync("supplier", []);

      expect(result.totalCodsuppliers).toBe(0);
      expect(result.totalItems).toBe(0);
      expect(client.request).not.toHaveBeenCalled();
    });

    it("works for contact type", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      contactHandler.syncAll.mockReturnValue({
        items: [{ CodSupplier: "P001", Name: "Acme" }],
        skippedDetails: [],
      });

      const result = await service.sync("contact");

      expect(result.target).toBe("contact");
      expect(client.request).toHaveBeenCalledWith("PUT", "/ingest-api/suppliers-contacts", expect.any(Array));
    });
  });

  describe("delete", () => {
    it("happy path — delegates to handler and sends DELETE batches", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      supplierHandler.deleteAll.mockReturnValue({
        items: [{ CodSupplier: "P001", DeletionDate: "2024-01-01" }],
        skippedDetails: [],
      });

      const result = await service.delete("supplier");

      expect(result.operation).toBe("delete");
      expect(result.target).toBe("supplier");
      expect(result.totalItems).toBe(1);
      expect(client.request).toHaveBeenCalledWith(
        "DELETE",
        "/ingest-api/suppliers",
        expect.arrayContaining([expect.objectContaining({ CodSupplier: "P001" })])
      );
    });

    it("works for contact type", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      contactHandler.deleteAll.mockReturnValue({
        items: [{ CodSupplier: "P001", NIF: "B12345", DeletionDate: "2024-01-01" }],
        skippedDetails: [],
      });

      const result = await service.delete("contact");

      expect(result.target).toBe("contact");
      expect(client.request).toHaveBeenCalledWith(
        "DELETE",
        "/ingest-api/suppliers-contacts",
        expect.any(Array)
      );
    });

    it("passes skippedDetails from handler", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      contactHandler.deleteAll.mockReturnValue({
        items: [],
        skippedDetails: [{ CodSupplier: "P001", reason: "Missing NIF (cif)" }],
      });

      const result = await service.delete("contact");

      expect(result.skipped).toBe(1);
      expect(result.skippedDetails[0].reason).toBe("Missing NIF (cif)");
    });
  });

  describe("batching", () => {
    it("chunks items into correct batch sizes", async () => {
      const items = Array.from({ length: 25 }, (_, i) => ({ CodSupplier: `P${i}` }));
      mockGetAllCodigos.mockReturnValue(Array.from({ length: 25 }, (_, i) => `P${i}`));
      supplierHandler.syncAll.mockReturnValue({ items, skippedDetails: [] });

      const result = await service.sync("supplier");

      expect(result.batches).toBe(3);
      expect(result.successBatches).toBe(3);
      expect(client.request).toHaveBeenCalledTimes(3);
    });

    it("counts failed batches correctly", async () => {
      const items = Array.from({ length: 25 }, (_, i) => ({ CodSupplier: `P${i}` }));
      mockGetAllCodigos.mockReturnValue(Array.from({ length: 25 }, (_, i) => `P${i}`));
      supplierHandler.syncAll.mockReturnValue({ items, skippedDetails: [] });

      let callCount = 0;
      client.request.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error("Batch 2 failed");
      });

      const result = await service.sync("supplier");

      expect(result.batches).toBe(3);
      expect(result.successBatches).toBe(2);
      expect(result.failedBatches).toBe(1);
    });
  });

  describe("mutex", () => {
    it("throws BulkOperationInProgressError on concurrent calls", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      supplierHandler.syncAll.mockReturnValue({ items: [{ CodSupplier: "P001" }], skippedDetails: [] });

      let resolveRequest: (() => void) | undefined;
      client.request.mockImplementation(
        () => new Promise<void>((resolve) => { resolveRequest = resolve; })
      );

      const first = service.sync("supplier");
      await new Promise((r) => setTimeout(r, 0));

      await expect(service.sync("supplier")).rejects.toThrow(BulkOperationInProgressError);

      resolveRequest!();
      await first;
    });

    it("allows sequential calls after first completes", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      supplierHandler.syncAll.mockReturnValue({ items: [{ CodSupplier: "P001" }], skippedDetails: [] });

      await service.sync("supplier");
      const result2 = await service.sync("supplier");

      expect(result2.totalItems).toBe(1);
    });
  });

  describe("BulkResult shape", () => {
    it("contains all required fields", async () => {
      mockGetAllCodigos.mockReturnValue(["P001"]);
      supplierHandler.syncAll.mockReturnValue({ items: [{ CodSupplier: "P001" }], skippedDetails: [] });

      const result = await service.sync("supplier");

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
});
