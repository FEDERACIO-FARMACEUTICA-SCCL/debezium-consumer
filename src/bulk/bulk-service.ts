import { logger } from "../logger";
import { ApiClient } from "../dispatch/http-client";
import { store } from "../domain/store";
import { ENTITY_MAP } from "../domain/entity-registry";
import { PayloadType } from "../types/payloads";
import { BulkResult } from "../types/deletions";
import { BulkHandler } from "./bulk-handler";

export class BulkService {
  private running = false;
  private handlers = new Map<PayloadType, BulkHandler>();

  constructor(
    private client: ApiClient,
    private batchSize: number
  ) {}

  registerHandler(handler: BulkHandler): void {
    this.handlers.set(handler.type, handler);
  }

  async sync(type: PayloadType, codigos?: string[]): Promise<BulkResult> {
    return this.withMutex(() => this.doSync(type, codigos));
  }

  async delete(type: PayloadType, codigos?: string[]): Promise<BulkResult> {
    return this.withMutex(() => this.doDelete(type, codigos));
  }

  private async doSync(type: PayloadType, filterCodigos?: string[]): Promise<BulkResult> {
    const start = Date.now();
    const handler = this.handlers.get(type)!;
    const entity = ENTITY_MAP.get(type)!;
    const codigos = filterCodigos ?? store.getAllCodigos("ctercero");

    const { items, skippedDetails } = handler.syncAll(codigos);

    const { successBatches, failedBatches, totalBatches } =
      await this.sendBatches("PUT", entity.apiPath, items, "sync", type);

    return {
      operation: "sync",
      target: type,
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

  private async doDelete(type: PayloadType, filterCodigos?: string[]): Promise<BulkResult> {
    const start = Date.now();
    const handler = this.handlers.get(type)!;
    const entity = ENTITY_MAP.get(type)!;
    const codigos = filterCodigos ?? store.getAllCodigos("ctercero");

    const { items, skippedDetails } = handler.deleteAll(codigos);

    const { successBatches, failedBatches, totalBatches } =
      await this.sendBatches("DELETE", entity.apiPath, items, "delete", type);

    return {
      operation: "delete",
      target: type,
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
