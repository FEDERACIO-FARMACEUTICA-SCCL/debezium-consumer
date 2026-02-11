import { logger } from "../logger";
import { ApiClient } from "../dispatch/http-client";
import { PayloadRegistry } from "../payloads/payload-builder";
import { store } from "../domain/store";
import { Supplier, SupplierContact } from "../types/payloads";
import {
  BulkResult,
  SkippedDetail,
  SupplierDeletion,
  SupplierContactDeletion,
} from "../types/deletions";

export class BulkService {
  private running = false;

  constructor(
    private client: ApiClient,
    private registry: PayloadRegistry,
    private batchSize: number
  ) {}

  async syncSuppliers(codigos?: string[]): Promise<BulkResult> {
    return this.withMutex(() => this.doSyncSuppliers(codigos));
  }

  async syncContacts(codigos?: string[]): Promise<BulkResult> {
    return this.withMutex(() => this.doSyncContacts(codigos));
  }

  async deleteSuppliers(codigos?: string[]): Promise<BulkResult> {
    return this.withMutex(() => this.doDeleteSuppliers(codigos));
  }

  async deleteContacts(codigos?: string[]): Promise<BulkResult> {
    return this.withMutex(() => this.doDeleteContacts(codigos));
  }

  private async doSyncSuppliers(filterCodigos?: string[]): Promise<BulkResult> {
    const start = Date.now();
    const codigos = filterCodigos ?? store.getAllCodigos("ctercero");
    const builder = this.registry.get("supplier");

    const items: Supplier[] = [];
    const skippedDetails: SkippedDetail[] = [];

    for (const codigo of codigos) {
      const ctercero = store.getSingle("ctercero", codigo);
      if (!ctercero) {
        skippedDetails.push({ CodSupplier: codigo, reason: "Not found in store (ctercero)" });
        continue;
      }
      const gproveed = store.getSingle("gproveed", codigo);
      if (!gproveed) {
        skippedDetails.push({ CodSupplier: codigo, reason: "Incomplete data: missing gproveed" });
        continue;
      }
      const result = builder?.build(codigo) as Supplier[] | null;
      if (result) {
        items.push(...result);
      } else {
        skippedDetails.push({ CodSupplier: codigo, reason: "Builder returned null" });
      }
    }

    const { successBatches, failedBatches, totalBatches } =
      await this.sendBatches("PUT", "/ingest-api/suppliers", items, "sync", "supplier");

    return {
      operation: "sync",
      target: "supplier",
      totalCodsuppliers: codigos.length,
      totalItems: items.length,
      batches: totalBatches,
      successBatches,
      failedBatches,
      skipped: skippedDetails.length,
      skippedDetails,
      durationMs: Date.now() - start,
    };
  }

  private async doSyncContacts(filterCodigos?: string[]): Promise<BulkResult> {
    const start = Date.now();
    const codigos = filterCodigos ?? store.getAllCodigos("ctercero");
    const builder = this.registry.get("contact");

    const items: SupplierContact[] = [];
    const skippedDetails: SkippedDetail[] = [];

    for (const codigo of codigos) {
      const ctercero = store.getSingle("ctercero", codigo);
      if (!ctercero) {
        skippedDetails.push({ CodSupplier: codigo, reason: "Not found in store (ctercero)" });
        continue;
      }
      const gproveed = store.getSingle("gproveed", codigo);
      if (!gproveed) {
        skippedDetails.push({ CodSupplier: codigo, reason: "Incomplete data: missing gproveed" });
        continue;
      }
      const direcciones = store.getArray("cterdire", codigo);
      if (direcciones.length === 0) {
        skippedDetails.push({ CodSupplier: codigo, reason: "No addresses found (cterdire)" });
        continue;
      }
      const result = builder?.build(codigo) as SupplierContact[] | null;
      if (result) {
        items.push(...result);
      } else {
        skippedDetails.push({ CodSupplier: codigo, reason: "Builder returned null" });
      }
    }

    const { successBatches, failedBatches, totalBatches } =
      await this.sendBatches("PUT", "/ingest-api/suppliers-contacts", items, "sync", "contact");

    return {
      operation: "sync",
      target: "contact",
      totalCodsuppliers: codigos.length,
      totalItems: items.length,
      batches: totalBatches,
      successBatches,
      failedBatches,
      skipped: skippedDetails.length,
      skippedDetails,
      durationMs: Date.now() - start,
    };
  }

  private async doDeleteSuppliers(filterCodigos?: string[]): Promise<BulkResult> {
    const start = Date.now();
    const codigos = filterCodigos ?? store.getAllCodigos("ctercero");
    const now = new Date().toISOString();

    const items: SupplierDeletion[] = [];
    const skippedDetails: SkippedDetail[] = [];

    for (const codigo of codigos) {
      const ctercero = store.getSingle("ctercero", codigo);
      if (!ctercero) {
        skippedDetails.push({ CodSupplier: codigo, reason: "Not found in store (ctercero)" });
        continue;
      }
      items.push({ CodSupplier: codigo, DeletionDate: now });
    }

    const { successBatches, failedBatches, totalBatches } =
      await this.sendBatches("DELETE", "/ingest-api/suppliers", items, "delete", "supplier");

    return {
      operation: "delete",
      target: "supplier",
      totalCodsuppliers: codigos.length,
      totalItems: items.length,
      batches: totalBatches,
      successBatches,
      failedBatches,
      skipped: skippedDetails.length,
      skippedDetails,
      durationMs: Date.now() - start,
    };
  }

  private async doDeleteContacts(filterCodigos?: string[]): Promise<BulkResult> {
    const start = Date.now();
    const codigos = filterCodigos ?? store.getAllCodigos("ctercero");
    const now = new Date().toISOString();

    const items: SupplierContactDeletion[] = [];
    const skippedDetails: SkippedDetail[] = [];

    for (const codigo of codigos) {
      const ctercero = store.getSingle("ctercero", codigo);
      if (!ctercero) {
        skippedDetails.push({ CodSupplier: codigo, reason: "Not found in store (ctercero)" });
        continue;
      }
      const nif = ctercero["cif"];
      if (nif == null || String(nif).trim() === "") {
        skippedDetails.push({ CodSupplier: codigo, reason: "Missing NIF (cif)" });
        continue;
      }
      items.push({
        CodSupplier: codigo,
        NIF: String(nif).trim(),
        DeletionDate: now,
      });
    }

    const { successBatches, failedBatches, totalBatches } =
      await this.sendBatches("DELETE", "/ingest-api/suppliers-contacts", items, "delete", "contact");

    return {
      operation: "delete",
      target: "contact",
      totalCodsuppliers: codigos.length,
      totalItems: items.length,
      batches: totalBatches,
      successBatches,
      failedBatches,
      skipped: skippedDetails.length,
      skippedDetails,
      durationMs: Date.now() - start,
    };
  }

  private async sendBatches(
    method: string,
    path: string,
    items: unknown[],
    operation: string,
    target: string
  ): Promise<{ totalBatches: number; successBatches: number; failedBatches: number }> {
    const chunks = this.chunk(items);
    const totalBatches = chunks.length;
    let successBatches = 0;
    let failedBatches = 0;
    let sentItems = 0;

    for (let i = 0; i < chunks.length; i++) {
      const batch = chunks[i];
      sentItems += batch.length;
      try {
        await this.client.request(method, path, batch);
        successBatches++;
        logger.info(
          {
            tag: "BulkSync",
            operation,
            target,
            batch: i + 1,
            totalBatches,
            items: batch.length,
            sentItems,
            totalItems: items.length,
          },
          `Batch ${i + 1}/${totalBatches} sent (${sentItems}/${items.length} items)`
        );
      } catch (err) {
        failedBatches++;
        logger.error(
          {
            tag: "BulkSync",
            operation,
            target,
            batch: i + 1,
            totalBatches,
            err,
          },
          `Batch ${i + 1}/${totalBatches} failed`
        );
      }
    }

    logger.info(
      {
        tag: "BulkSync",
        operation,
        target,
        totalItems: items.length,
        batches: totalBatches,
        successBatches,
        failedBatches,
      },
      `Bulk ${operation} ${target} completed: ${successBatches}/${totalBatches} batches OK`
    );

    return { totalBatches, successBatches, failedBatches };
  }

  private chunk<T>(arr: T[]): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += this.batchSize) {
      chunks.push(arr.slice(i, i + this.batchSize));
    }
    return chunks;
  }

  private async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running) {
      throw new BulkOperationInProgressError();
    }
    this.running = true;
    try {
      return await fn();
    } finally {
      this.running = false;
    }
  }
}

export class BulkOperationInProgressError extends Error {
  constructor() {
    super("A bulk operation is already in progress");
  }
}
