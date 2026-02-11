import { TABLE_REGISTRY, TableDefinition } from "./table-registry";

export type StoreRecord = Record<string, unknown>;

export class InMemoryStore {
  private singleStores = new Map<string, Map<string, StoreRecord>>();
  private arrayStores = new Map<string, Map<string, StoreRecord[]>>();

  constructor(definitions: TableDefinition[] = TABLE_REGISTRY) {
    for (const def of definitions) {
      if (def.storeKind === "single") {
        this.singleStores.set(def.table, new Map());
      } else {
        this.arrayStores.set(def.table, new Map());
      }
    }
  }

  update(
    table: string,
    op: string,
    before: StoreRecord | null,
    after: StoreRecord | null
  ): void {
    const tableLower = table.toLowerCase();

    const arrayStore = this.arrayStores.get(tableLower);
    if (arrayStore) {
      this.updateArrayStore(arrayStore, op, before, after);
      return;
    }

    const singleStore = this.singleStores.get(tableLower);
    if (!singleStore) return;

    if (op === "d") {
      const codigo = String(before?.["codigo"] ?? "").trim();
      if (codigo) singleStore.delete(codigo);
    } else {
      const codigo = String(after?.["codigo"] ?? "").trim();
      if (codigo && after) singleStore.set(codigo, after);
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

  clear(): void {
    for (const map of this.singleStores.values()) map.clear();
    for (const map of this.arrayStores.values()) map.clear();
  }

  private updateArrayStore(
    store: Map<string, StoreRecord[]>,
    op: string,
    before: StoreRecord | null,
    after: StoreRecord | null
  ): void {
    if (op === "c" || op === "r") {
      if (!after) return;
      const codigo = String(after["codigo"] ?? "").trim();
      if (!codigo) return;

      const arr = store.get(codigo) ?? [];
      const duplicate = arr.some((r) => this.recordsMatch(r, after));
      if (!duplicate) {
        arr.push(after);
        store.set(codigo, arr);
      }
      return;
    }

    if (op === "u") {
      if (!before || !after) return;
      const codigo = String(before["codigo"] ?? "").trim();
      if (!codigo) return;

      const arr = store.get(codigo) ?? [];
      const idx = arr.findIndex((r) => this.recordsMatch(r, before));
      if (idx >= 0) {
        arr[idx] = after;
      } else {
        arr.push(after);
      }
      store.set(codigo, arr);
      return;
    }

    if (op === "d") {
      if (!before) return;
      const codigo = String(before["codigo"] ?? "").trim();
      if (!codigo) return;

      const arr = store.get(codigo) ?? [];
      const idx = arr.findIndex((r) => this.recordsMatch(r, before));
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
