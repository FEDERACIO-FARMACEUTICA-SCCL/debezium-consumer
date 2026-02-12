import { TABLE_REGISTRY, TableDefinition } from "./table-registry";

export type StoreRecord = Record<string, unknown>;

export class InMemoryStore {
  private singleStores = new Map<string, Map<string, StoreRecord>>();
  private arrayStores = new Map<string, Map<string, StoreRecord[]>>();
  private fieldFilters = new Map<string, Set<string>>();
  private keyFields = new Map<string, string>();

  constructor(definitions: TableDefinition[] = TABLE_REGISTRY) {
    for (const def of definitions) {
      if (def.storeKind === "single") {
        this.singleStores.set(def.table, new Map());
      } else {
        this.arrayStores.set(def.table, new Map());
      }
      if (def.storeFields?.length) {
        this.fieldFilters.set(def.table, new Set(def.storeFields));
      }
      this.keyFields.set(def.table, def.keyField ?? "codigo");
    }
  }

  update(
    table: string,
    op: string,
    before: StoreRecord | null,
    after: StoreRecord | null
  ): void {
    const tableLower = table.toLowerCase();
    const fields = this.fieldFilters.get(tableLower);
    const filteredBefore = pickFields(before, fields);
    const filteredAfter = pickFields(after, fields);

    const keyField = this.keyFields.get(tableLower) ?? "codigo";

    const arrayStore = this.arrayStores.get(tableLower);
    if (arrayStore) {
      this.updateArrayStore(arrayStore, op, filteredBefore, filteredAfter, keyField);
      return;
    }

    const singleStore = this.singleStores.get(tableLower);
    if (!singleStore) return;

    if (op === "d") {
      const key = String(filteredBefore?.[keyField] ?? "").trim();
      if (key) singleStore.delete(key);
    } else {
      const key = String(filteredAfter?.[keyField] ?? "").trim();
      if (key && filteredAfter) singleStore.set(key, filteredAfter);
    }
  }

  getSingle(table: string, codigo: string): StoreRecord | undefined {
    return this.singleStores.get(table)?.get(codigo);
  }

  getArray(table: string, codigo: string): StoreRecord[] {
    return this.arrayStores.get(table)?.get(codigo) ?? [];
  }

  getStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const [table, map] of this.singleStores) {
      stats[table] = map.size;
    }
    for (const [table, map] of this.arrayStores) {
      let total = 0;
      for (const arr of map.values()) total += arr.length;
      stats[table] = total;
    }
    return stats;
  }

  getAllCodigos(table: string): string[] {
    const single = this.singleStores.get(table);
    if (single) return [...single.keys()];
    const array = this.arrayStores.get(table);
    if (array) return [...array.keys()];
    return [];
  }

  getMemoryEstimate(): Record<string, number> {
    const sizes: Record<string, number> = {};
    for (const [table, map] of this.singleStores) {
      let bytes = 0;
      for (const record of map.values()) {
        bytes += estimateRecordBytes(record);
      }
      sizes[table] = bytes;
    }
    for (const [table, map] of this.arrayStores) {
      let bytes = 0;
      for (const arr of map.values()) {
        for (const record of arr) {
          bytes += estimateRecordBytes(record);
        }
      }
      sizes[table] = bytes;
    }
    return sizes;
  }

  clear(): void {
    for (const map of this.singleStores.values()) map.clear();
    for (const map of this.arrayStores.values()) map.clear();
  }

  private updateArrayStore(
    store: Map<string, StoreRecord[]>,
    op: string,
    before: StoreRecord | null,
    after: StoreRecord | null,
    keyField: string
  ): void {
    if (op === "c" || op === "r") {
      if (!after) return;
      const key = String(after[keyField] ?? "").trim();
      if (!key) return;

      const arr = store.get(key) ?? [];
      const duplicate = arr.some((r) => this.recordsMatch(r, after));
      if (!duplicate) {
        arr.push(after);
        store.set(key, arr);
      }
      return;
    }

    if (op === "u") {
      if (!before || !after) return;
      const key = String(before[keyField] ?? "").trim();
      if (!key) return;

      const arr = store.get(key) ?? [];
      const idx = arr.findIndex((r) => this.recordsMatch(r, before));
      if (idx >= 0) {
        arr[idx] = after;
      } else {
        arr.push(after);
      }
      store.set(key, arr);
      return;
    }

    if (op === "d") {
      if (!before) return;
      const key = String(before[keyField] ?? "").trim();
      if (!key) return;

      const arr = store.get(key) ?? [];
      const idx = arr.findIndex((r) => this.recordsMatch(r, before));
      if (idx >= 0) {
        arr.splice(idx, 1);
        if (arr.length === 0) {
          store.delete(key);
        } else {
          store.set(key, arr);
        }
      }
    }
  }

  private recordsMatch(stored: StoreRecord, before: StoreRecord): boolean {
    for (const key of Object.keys(before)) {
      const a = this.normalizeValue(stored[key]);
      const b = this.normalizeValue(before[key]);
      if (a !== b) return false;
    }
    return true;
  }

  private normalizeValue(val: unknown): unknown {
    if (typeof val === "string") return val.trim();
    return val;
  }
}

function pickFields(
  record: StoreRecord | null,
  fields: Set<string> | undefined
): StoreRecord | null {
  if (!record || !fields) return record;
  const out: StoreRecord = {};
  for (const key of fields) {
    if (key in record) out[key] = record[key];
  }
  return out;
}

function estimateRecordBytes(record: StoreRecord): number {
  let bytes = 64; // object overhead
  for (const [key, val] of Object.entries(record)) {
    bytes += key.length * 2 + 32; // key string + property slot
    if (typeof val === "string") bytes += val.length * 2 + 32;
    else if (typeof val === "number") bytes += 8;
    else if (val === null || val === undefined) bytes += 0;
    else bytes += 32;
  }
  return bytes;
}

// Singleton instance
export const store = new InMemoryStore();

// Convenience wrappers (backward compatible)
export function updateStore(
  table: string,
  op: string,
  before: StoreRecord | null,
  after: StoreRecord | null
): void {
  store.update(table, op, before, after);
}

export function getCtercero(codigo: string): StoreRecord | undefined {
  return store.getSingle("ctercero", codigo);
}

export function getGproveed(codigo: string): StoreRecord | undefined {
  return store.getSingle("gproveed", codigo);
}

export function getCterdire(codigo: string): StoreRecord[] {
  return store.getArray("cterdire", codigo);
}

export function getStoreStats(): Record<string, number> {
  return store.getStats();
}

export function getAllCodigos(table: string): string[] {
  return store.getAllCodigos(table);
}
