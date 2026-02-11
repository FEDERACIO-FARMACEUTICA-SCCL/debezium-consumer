import { PayloadType, AnyPayload } from "../types/payloads";
import { PayloadRegistry } from "../payloads/payload-builder";
import { PayloadDispatcher } from "./dispatcher";
import { addPending } from "./pending-buffer";
import { ENTITY_LABELS } from "../domain/entity-registry";
import { logger } from "../logger";

export class CdcDebouncer {
  private buffer = new Map<string, Set<PayloadType>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(
    private registry: PayloadRegistry,
    private dispatcher: PayloadDispatcher,
    private windowMs: number,
    private maxBufferSize: number,
    private batchSize: number
  ) {}

  enqueue(codigo: string, types: Set<PayloadType>): void {
    const existing = this.buffer.get(codigo);
    if (existing) {
      for (const t of types) existing.add(t);
    } else {
      this.buffer.set(codigo, new Set(types));
    }

    logger.debug(
      { tag: "Debounce", codigo, types: [...types], bufferSize: this.buffer.size },
      "Enqueued"
    );

    if (this.buffer.size >= this.maxBufferSize) {
      this.flush();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.windowMs);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.size === 0) return;
    this.flushing = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Snapshot and clear
    const snapshot = new Map(this.buffer);
    this.buffer.clear();

    const start = Date.now();

    // Group items by payload type
    const grouped = new Map<PayloadType, AnyPayload>();

    for (const [codigo, types] of snapshot) {
      for (const type of types) {
        const builder = this.registry.get(type);
        if (!builder) continue;

        const built = builder.build(codigo);
        if (built) {
          const tag = ENTITY_LABELS[type] ?? type;
          logger.debug({ tag, codigo, payload: built }, `${tag} payload details`);

          const acc = grouped.get(type);
          if (acc) {
            (acc as unknown[]).push(...(built as unknown[]));
          } else {
            grouped.set(type, [...(built as unknown[])] as AnyPayload);
          }
        } else {
          addPending(codigo, type);
        }
      }
    }

    // Dispatch each type in batches
    for (const [type, items] of grouped) {
      const arr = items as unknown[];
      for (let i = 0; i < arr.length; i += this.batchSize) {
        const batch = arr.slice(i, i + this.batchSize) as AnyPayload;
        try {
          await this.dispatcher.dispatch(type, "batch", batch);
        } catch (err) {
          logger.error(
            { tag: "Debounce", type, batchSize: (batch as unknown[]).length, err },
            "Batch dispatch failed"
          );
        }
      }
    }

    const durationMs = Date.now() - start;
    const summary: Record<string, number> = {};
    for (const [type, items] of grouped) {
      summary[type] = (items as unknown[]).length;
    }

    logger.info(
      { tag: "Debounce", codigos: snapshot.size, items: summary, durationMs },
      `Flushed ${snapshot.size} codigos`
    );

    this.flushing = false;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
