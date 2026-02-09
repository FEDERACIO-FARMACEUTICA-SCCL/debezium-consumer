type StoreRecord = Record<string, unknown>;

const cterceroStore = new Map<string, StoreRecord>();
const gproveedStore = new Map<string, StoreRecord>();

const stores: Record<string, Map<string, StoreRecord>> = {
  ctercero: cterceroStore,
  gproveed: gproveedStore,
};

/**
 * Update the in-memory store with data from a CDC event.
 * Must be called for EVERY event (including snapshots) to keep the cache current.
 */
export function updateStore(
  table: string,
  op: string,
  before: StoreRecord | null,
  after: StoreRecord | null
): void {
  const store = stores[table.toLowerCase()];
  if (!store) return;

  if (op === "d") {
    const codigo = String(before?.["codigo"] ?? "").trim();
    if (codigo) store.delete(codigo);
  } else {
    const codigo = String(after?.["codigo"] ?? "").trim();
    if (codigo && after) store.set(codigo, after);
  }
}

export function getCtercero(codigo: string): StoreRecord | undefined {
  return cterceroStore.get(codigo);
}

export function getGproveed(codigo: string): StoreRecord | undefined {
  return gproveedStore.get(codigo);
}

export function getStoreStats(): Record<string, number> {
  return {
    ctercero: cterceroStore.size,
    gproveed: gproveedStore.size,
  };
}
