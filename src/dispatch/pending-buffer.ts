import { PayloadType } from "../types/payloads";
import { PayloadRegistry } from "../payloads/payload-builder";
import { PayloadDispatcher } from "./dispatcher";
import { logger } from "../logger";

interface PendingEntry {
  codigo: string;
  types: Set<PayloadType>;
  retries: number;
  addedAt: number;
}

const MAX_RETRIES = 5;
const RETRY_INTERVAL_MS = 2000;
const MAX_AGE_MS = 60_000;
const MAX_PENDING_SIZE = 10_000;

const pending = new Map<string, PendingEntry>();
let timer: ReturnType<typeof setInterval> | null = null;
let retrying = false;

export function addPending(codigo: string, type: PayloadType): void {
  const existing = pending.get(codigo);
  if (existing) {
    existing.types.add(type);
    return;
  }
  if (pending.size >= MAX_PENDING_SIZE) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) {
      const evicted = pending.get(oldest);
      logger.warn(
        { tag: "PendingBuffer", codigo: oldest, types: evicted ? [...evicted.types] : [] },
        "Buffer at capacity, evicting oldest entry"
      );
      pending.delete(oldest);
    }
  }
  pending.set(codigo, {
    codigo,
    types: new Set([type]),
    retries: 0,
    addedAt: Date.now(),
  });
}

export function startRetryLoop(
  registry: PayloadRegistry,
  dispatcher: PayloadDispatcher
): void {
  if (timer) return;

  timer = setInterval(async () => {
    if (retrying || pending.size === 0) return;
    retrying = true;
    try {
      for (const [codigo, entry] of pending) {
        entry.retries++;

        if (
          entry.retries > MAX_RETRIES ||
          Date.now() - entry.addedAt > MAX_AGE_MS
        ) {
          logger.warn(
            {
              tag: "PendingBuffer",
              codigo,
              retries: entry.retries,
              types: [...entry.types],
            },
            "Giving up on pending codigo"
          );
          pending.delete(codigo);
          continue;
        }

        for (const type of entry.types) {
          const builder = registry.get(type);
          if (!builder) continue;

          const payload = builder.build(codigo);
          if (payload) {
            const tagMap: Record<string, string> = {
              supplier: "Supplier",
              contact: "SupplierContact",
            };
            const tag = tagMap[type] ?? type;
            try {
              await dispatcher.dispatch(type, codigo, payload);
              entry.types.delete(type);
              logger.info({ tag: "PendingBuffer", codigo }, `${tag} retry succeeded`);
              logger.debug(
                { tag: "PendingBuffer", codigo, payload },
                `${tag} retry payload`
              );
            } catch (err) {
              logger.error(
                { tag: "PendingBuffer", codigo, type, err },
                `${tag} retry dispatch failed, will retry next cycle`
              );
            }
          }
        }

        if (entry.types.size === 0) {
          pending.delete(codigo);
        }
      }
    } finally {
      retrying = false;
    }
  }, RETRY_INTERVAL_MS);
}

export function stopRetryLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getPendingStats(): { count: number; codigos: string[] } {
  return {
    count: pending.size,
    codigos: [...pending.keys()],
  };
}
