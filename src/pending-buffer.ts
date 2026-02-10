import { AppConfig } from "./config";
import { buildSupplierPayload } from "./supplier";
import { buildSupplierContactPayload } from "./supplier-contact";
import { logger } from "./logger";

interface PendingEntry {
  codigo: string;
  types: Set<"supplier" | "contact">;
  retries: number;
  addedAt: number;
}

const MAX_RETRIES = 5;
const RETRY_INTERVAL_MS = 2000;
const MAX_AGE_MS = 60_000;
const MAX_PENDING_SIZE = 10_000;

const pending = new Map<string, PendingEntry>();
let timer: ReturnType<typeof setInterval> | null = null;

export function addPending(
  codigo: string,
  type: "supplier" | "contact"
): void {
  const existing = pending.get(codigo);
  if (existing) {
    existing.types.add(type);
    return;
  }
  if (pending.size >= MAX_PENDING_SIZE) {
    // Evict oldest entry to stay within bounds
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
  pending.set(codigo, {
    codigo,
    types: new Set([type]),
    retries: 0,
    addedAt: Date.now(),
  });
}

export function startRetryLoop(config: AppConfig): void {
  if (timer) return;

  timer = setInterval(() => {
    if (pending.size === 0) return;

    for (const [codigo, entry] of pending) {
      entry.retries++;

      // Expire entries that exceeded max retries or age
      if (entry.retries > MAX_RETRIES || Date.now() - entry.addedAt > MAX_AGE_MS) {
        logger.warn(
          { tag: "PendingBuffer", codigo, retries: entry.retries, types: [...entry.types] },
          "Giving up on pending codigo"
        );
        pending.delete(codigo);
        continue;
      }

      // Retry supplier
      if (entry.types.has("supplier")) {
        const payload = buildSupplierPayload(codigo);
        if (payload) {
          entry.types.delete("supplier");
          logger.info(
            { tag: "PendingBuffer", codigo },
            "Supplier retry succeeded"
          );
          logger.debug(
            { tag: "PendingBuffer", codigo, payload },
            "Supplier retry payload"
          );
          // TODO: enviar supplierPayload a la API REST
        }
      }

      // Retry contact
      if (entry.types.has("contact")) {
        const payload = buildSupplierContactPayload(codigo);
        if (payload) {
          entry.types.delete("contact");
          logger.info(
            { tag: "PendingBuffer", codigo },
            "SupplierContact retry succeeded"
          );
          logger.debug(
            { tag: "PendingBuffer", codigo, payload },
            "SupplierContact retry payload"
          );
          // TODO: enviar contactPayload a la API REST
        }
      }

      // Remove entry if all types resolved
      if (entry.types.size === 0) {
        pending.delete(codigo);
      }
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
