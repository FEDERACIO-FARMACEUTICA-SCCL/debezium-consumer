import { PayloadType } from "../types/payloads";

export interface WatchedField {
  field: string;
  payloads: PayloadType[];
}

export interface TableDefinition {
  table: string;
  storeKind: "single" | "array";
  watchedFields: WatchedField[];
  topic: string;
  /** Fields to keep in the in-memory store (all others are discarded).
   *  Omit or set to empty to keep all fields (no filtering). */
  storeFields?: string[];
}

export const TABLE_REGISTRY: TableDefinition[] = [
  {
    table: "ctercero",
    storeKind: "single",
    watchedFields: [
      { field: "codigo", payloads: ["supplier", "contact"] },
      { field: "nombre", payloads: ["supplier", "contact"] },
      { field: "cif", payloads: ["supplier", "contact"] },
      { field: "codare", payloads: ["supplier", "contact"] },
    ],
    topic: "informix.informix.ctercero",
    storeFields: ["codigo", "nombre", "cif", "codare"],
  },
  {
    table: "gproveed",
    storeKind: "single",
    watchedFields: [
      { field: "fecalt", payloads: ["supplier"] },
      { field: "fecbaj", payloads: ["supplier", "contact"] },
    ],
    topic: "informix.informix.gproveed",
    storeFields: ["codigo", "fecalt", "fecbaj"],
  },
  {
    table: "cterdire",
    storeKind: "array",
    watchedFields: [
      { field: "direcc", payloads: ["contact"] },
      { field: "poblac", payloads: ["contact"] },
      { field: "codnac", payloads: ["contact"] },
      { field: "codpos", payloads: ["contact"] },
      { field: "telef1", payloads: ["contact"] },
      { field: "email", payloads: ["contact"] },
    ],
    topic: "informix.informix.cterdire",
    storeFields: ["codigo", "tipdir", "direcc", "poblac", "codnac", "codpos", "telef1", "email"],
  },
];

// Derived lookups (computed once at module load)

export const TABLE_MAP = new Map<string, TableDefinition>(
  TABLE_REGISTRY.map((def) => [def.table, def])
);

export const WATCHED_FIELDS: Record<string, string[]> = Object.fromEntries(
  TABLE_REGISTRY.map((def) => [def.table, def.watchedFields.map((wf) => wf.field)])
);

// field-level lookup: "table.field" → Set<PayloadType>
export const FIELD_TO_PAYLOADS = new Map<string, Set<PayloadType>>(
  TABLE_REGISTRY.flatMap((def) =>
    def.watchedFields.map((wf) => [`${def.table}.${wf.field}`, new Set(wf.payloads)] as const)
  )
);

export const ALL_TOPICS: string[] = TABLE_REGISTRY.map((def) => def.topic);
