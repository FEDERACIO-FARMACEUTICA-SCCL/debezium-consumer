export type StoreRecord = Record<string, unknown>;

// --- Single-record stores (1 registro por codigo) ---
const cterceroStore = new Map<string, StoreRecord>();
const gproveedStore = new Map<string, StoreRecord>();

const singleStores: Record<string, Map<string, StoreRecord>> = {
  ctercero: cterceroStore,
  gproveed: gproveedStore,
};

// --- Array store (N registros por codigo) ---
const cterdireStore = new Map<string, StoreRecord[]>();

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
  const tableLower = table.toLowerCase();

  if (tableLower === "cterdire") {
    updateArrayStore(cterdireStore, op, before, after);
    return;
  }

  const store = singleStores[tableLower];
  if (!store) return;

  if (op === "d") {
    const codigo = String(before?.["codigo"] ?? "").trim();
    if (codigo) store.delete(codigo);
  } else {
    const codigo = String(after?.["codigo"] ?? "").trim();
    if (codigo && after) store.set(codigo, after);
  }
}

/**
 * Update an array-based store (tables without PK, 1-to-many relationship).
 * Uses full `before` comparison to identify the specific record.
 */
function updateArrayStore(
  store: Map<string, StoreRecord[]>,
  op: string,
  before: StoreRecord | null,
  after: StoreRecord | null
): void {
  if (op === "c" || op === "r") {
    // Insert / snapshot: add to array
    if (!after) return;
    const codigo = String(after["codigo"] ?? "").trim();
    if (!codigo) return;

    const arr = store.get(codigo) ?? [];
    arr.push(after);
    store.set(codigo, arr);
    return;
  }

  if (op === "u") {
    // Update: find record matching `before`, replace with `after`
    if (!before || !after) return;
    const codigo = String(before["codigo"] ?? "").trim();
    if (!codigo) return;

    const arr = store.get(codigo) ?? [];
    const idx = arr.findIndex((r) => recordsMatch(r, before));
    if (idx >= 0) {
      arr[idx] = after;
    } else {
      // Not found (shouldn't happen), add as new
      arr.push(after);
    }
    store.set(codigo, arr);
    return;
  }

  if (op === "d") {
    // Delete: find record matching `before`, remove
    if (!before) return;
    const codigo = String(before["codigo"] ?? "").trim();
    if (!codigo) return;

    const arr = store.get(codigo) ?? [];
    const idx = arr.findIndex((r) => recordsMatch(r, before));
    if (idx >= 0) {
      arr.splice(idx, 1);
      if (arr.length === 0) {
        store.delete(codigo);
      } else {
        store.set(codigo, arr);
      }
    }
  }
}

/**
 * Compare two records field by field.
 * Handles Informix CHAR padding by trimming string values.
 */
function recordsMatch(stored: StoreRecord, before: StoreRecord): boolean {
  for (const key of Object.keys(before)) {
    const a = normalizeValue(stored[key]);
    const b = normalizeValue(before[key]);
    if (a !== b) return false;
  }
  return true;
}

function normalizeValue(val: unknown): unknown {
  if (typeof val === "string") return val.trim();
  return val;
}

// --- Getters ---

export function getCtercero(codigo: string): StoreRecord | undefined {
  return cterceroStore.get(codigo);
}

export function getGproveed(codigo: string): StoreRecord | undefined {
  return gproveedStore.get(codigo);
}

export function getCterdire(codigo: string): StoreRecord[] {
  return cterdireStore.get(codigo) ?? [];
}

export function getStoreStats(): Record<string, number> {
  let cterdireTotal = 0;
  for (const arr of cterdireStore.values()) {
    cterdireTotal += arr.length;
  }

  return {
    ctercero: cterceroStore.size,
    gproveed: gproveedStore.size,
    cterdire: cterdireTotal,
  };
}
