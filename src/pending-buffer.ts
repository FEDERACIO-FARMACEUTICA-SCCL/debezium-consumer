import { AppConfig } from "./config";
import { buildSupplierPayload } from "./supplier";
import { buildSupplierContactPayload } from "./supplier-contact";

interface PendingEntry {
  codigo: string;
  types: Set<"supplier" | "contact">;
  retries: number;
  addedAt: number;
}

const MAX_RETRIES = 5;
const RETRY_INTERVAL_MS = 2000;
const MAX_AGE_MS = 60_000;

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
        console.log(
          `[PendingBuffer] Giving up on codigo=${codigo} after ${entry.retries} retries (types: ${[...entry.types].join(", ")})`
        );
        pending.delete(codigo);
        continue;
      }

      // Retry supplier
      if (entry.types.has("supplier")) {
        const payload = buildSupplierPayload(codigo);
        if (payload) {
          entry.types.delete("supplier");
          if (config.logLevel === "debug") {
            console.log(
              `[PendingBuffer] Supplier retry succeeded for codigo=${codigo}:`,
              JSON.stringify(payload, null, 2)
            );
          } else {
            console.log(
              `[PendingBuffer] Supplier retry succeeded for codigo=${codigo}`
            );
          }
          // TODO: enviar supplierPayload a la API REST
        }
      }

      // Retry contact
      if (entry.types.has("contact")) {
        const payload = buildSupplierContactPayload(codigo);
        if (payload) {
          entry.types.delete("contact");
          if (config.logLevel === "debug") {
            console.log(
              `[PendingBuffer] SupplierContact retry succeeded for codigo=${codigo}:`,
              JSON.stringify(payload, null, 2)
            );
          } else {
            console.log(
              `[PendingBuffer] SupplierContact retry succeeded for codigo=${codigo}`
            );
          }
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
