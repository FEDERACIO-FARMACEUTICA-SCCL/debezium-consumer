import { PayloadType } from "../types/payloads";

export interface TableDefinition {
  table: string;
  storeKind: "single" | "array";
  watchedFields: string[];
  feedsPayloads: PayloadType[];
  topic: string;
}

export const TABLE_REGISTRY: TableDefinition[] = [
  {
    table: "ctercero",
    storeKind: "single",
    watchedFields: ["codigo", "nombre", "cif"],
    feedsPayloads: ["supplier", "contact"],
    topic: "informix.informix.ctercero",
  },
  {
    table: "gproveed",
    storeKind: "single",
    watchedFields: ["fecalt", "fecbaj"],
    feedsPayloads: ["supplier", "contact"],
    topic: "informix.informix.gproveed",
  },
  {
    table: "cterdire",
    storeKind: "array",
    watchedFields: ["direcc", "poblac", "codnac", "codpos", "telef1", "email"],
    feedsPayloads: ["contact"],
    topic: "informix.informix.cterdire",
  },
];

// Derived lookups (computed once at module load)

export const TABLE_MAP = new Map<string, TableDefinition>(
  TABLE_REGISTRY.map((def) => [def.table, def])
);

export const WATCHED_FIELDS: Record<string, string[]> = Object.fromEntries(
  TABLE_REGISTRY.map((def) => [def.table, def.watchedFields])
);

export const TABLE_TO_PAYLOADS = new Map<string, Set<PayloadType>>(
  TABLE_REGISTRY.map((def) => [def.table, new Set(def.feedsPayloads)])
);

export const ALL_TOPICS: string[] = TABLE_REGISTRY.map((def) => def.topic);
