import { PayloadType } from "../types/payloads";

export interface EntityDefinition {
  type: PayloadType;
  label: string;
  triggerPath: string;
  apiPath: string;
  swagger: {
    sync: { summary: string; description: string };
    delete: { summary: string; description: string };
  };
}

export const ENTITY_REGISTRY: EntityDefinition[] = [
  {
    type: "supplier",
    label: "Supplier",
    triggerPath: "suppliers",
    apiPath: "/ingest-api/suppliers",
    swagger: {
      sync: {
        summary: "Bulk sync suppliers",
        description:
          "Reads all suppliers from the in-memory store, builds payloads and sends them to the ingest API in batches.",
      },
      delete: {
        summary: "Bulk delete suppliers",
        description:
          "Sends a deletion payload for every supplier in the store to the ingest API.",
      },
    },
  },
  {
    type: "contact",
    label: "SupplierContact",
    triggerPath: "contacts",
    apiPath: "/ingest-api/suppliers-contacts",
    swagger: {
      sync: {
        summary: "Bulk sync supplier contacts",
        description:
          "Reads all supplier contacts from the in-memory store, builds payloads and sends them to the ingest API in batches.",
      },
      delete: {
        summary: "Bulk delete supplier contacts",
        description:
          "Sends a deletion payload for every supplier contact in the store to the ingest API.",
      },
    },
  },
  {
    type: "agreement",
    label: "Agreement",
    triggerPath: "agreements",
    apiPath: "/ingest-api/agreements",
    swagger: {
      sync: {
        summary: "Bulk sync agreements",
        description:
          "Reads all agreements from the store, builds payloads and sends them to the ingest API in batches.",
      },
      delete: {
        summary: "Bulk delete agreements",
        description:
          "Sends a deletion payload for every agreement in the store to the ingest API.",
      },
    },
  },
];

export const ENTITY_MAP = new Map(
  ENTITY_REGISTRY.map((e) => [e.type, e])
);

export const ENTITY_LABELS: Record<string, string> = Object.fromEntries(
  ENTITY_REGISTRY.map((e) => [e.type, e.label])
);

export const ENTITY_ENDPOINTS: Record<string, string> = Object.fromEntries(
  ENTITY_REGISTRY.map((e) => [e.type, e.apiPath])
);
