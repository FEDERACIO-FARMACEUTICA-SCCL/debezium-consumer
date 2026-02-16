import { SqliteStore } from "./sqlite-store";

export type { StoreRecord } from "./sqlite-store";

// Mutable singleton (same pattern as logger.ts)
// Initialized from index.ts after config loads via initStore()
export let store: SqliteStore;

export function initStore(dbPath: string): void {
  // Lazy import to avoid circular dependency at module load time
  const { TABLE_REGISTRY } = require("./table-registry");
  store = new SqliteStore(dbPath, TABLE_REGISTRY);
}

// Convenience wrappers (backward compatible)
export function updateStore(
  table: string,
  op: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): void {
  store.update(table, op, before, after);
}

export function getCtercero(
  codigo: string
): Record<string, unknown> | undefined {
  return store.getSingle("ctercero", codigo);
}

export function getGproveed(
  codigo: string
): Record<string, unknown> | undefined {
  return store.getSingle("gproveed", codigo);
}

export function getCterdire(codigo: string): Record<string, unknown>[] {
  return store.getArray("cterdire", codigo);
}

export function getStoreStats(): Record<string, number> {
  return store.getStats();
}

export function getAllCodigos(table: string): string[] {
  return store.getAllCodigos(table);
}
