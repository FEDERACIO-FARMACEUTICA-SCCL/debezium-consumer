// Shared response schemas

const BulkResultResponse = {
  type: "object",
  properties: {
    operation: { type: "string", enum: ["sync", "delete"] },
    target: { type: "string" },
    totalCodsuppliers: { type: "number" },
    totalItems: { type: "number" },
    batches: { type: "number" },
    successBatches: { type: "number" },
    failedBatches: { type: "number" },
    skipped: { type: "number" },
    skippedDetails: {
      type: "array",
      items: {
        type: "object",
        properties: {
          CodSupplier: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    durationMs: { type: "number" },
  },
} as const;

const ErrorResponse = {
  type: "object",
  properties: {
    error: { type: "string" },
  },
} as const;

const triggerResponses = {
  200: { description: "Operation completed", ...BulkResultResponse },
  401: { description: "Unauthorized", ...ErrorResponse },
  409: { description: "A bulk operation is already in progress", ...ErrorResponse },
  500: { description: "Internal server error", ...ErrorResponse },
} as const;

export const TriggerBody = {
  type: "object",
  properties: {
    CodSupplier: {
      type: "array",
      items: { type: "string", maxLength: 50 },
      maxItems: 10_000,
      description:
        "Optional list of supplier codes to process. If omitted, all codes are processed.",
    },
  },
} as const;

export const healthSchema = {
  tags: ["System"],
  summary: "Health check",
  description: "Returns OK if the server is running",
  response: {
    200: {
      description: "Server is healthy",
      type: "object",
      properties: {
        status: { type: "string", enum: ["ok"] },
      },
    },
  },
};

export function makeTriggerSchema(meta: { summary: string; description: string }) {
  return {
    tags: ["Triggers"],
    summary: meta.summary,
    description: meta.description,
    security: [{ bearerAuth: [] }],
    body: TriggerBody,
    response: triggerResponses,
  };
}

// --- Store Viewer schemas ---

const storeViewerSecurity = [{ bearerAuth: [] }];

const storeErrorResponses = {
  401: { description: "Unauthorized", ...ErrorResponse },
  404: { description: "Not found", ...ErrorResponse },
} as const;

export const storeStatsSchema = {
  tags: ["Store Viewer"],
  summary: "Get store stats",
  description: "Returns record counts per table and the total across all tables.",
  security: storeViewerSecurity,
  response: {
    200: {
      description: "Store statistics",
      type: "object",
      properties: {
        tables: {
          type: "object",
          additionalProperties: { type: "number" },
        },
        total: { type: "number" },
      },
    },
    401: storeErrorResponses[401],
  },
};

export const storeTableSchema = {
  tags: ["Store Viewer"],
  summary: "List codigos in a table",
  description: "Returns all codigos stored for a given table, along with the store kind and count.",
  security: storeViewerSecurity,
  params: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table name (e.g. ctercero, gproveed, cterdire)" },
    },
    required: ["table"],
  },
  response: {
    200: {
      description: "Table codigos",
      type: "object",
      properties: {
        table: { type: "string" },
        storeKind: { type: "string", enum: ["single", "array"] },
        codigos: { type: "array", items: { type: "string" } },
        total: { type: "number" },
      },
    },
    ...storeErrorResponses,
  },
};

export const storeRecordSchema = {
  tags: ["Store Viewer"],
  summary: "Get record by table and codigo",
  description:
    "Returns the stored data for a specific codigo in a table. For single-kind tables returns an object (or null). For array-kind tables returns an array.",
  security: storeViewerSecurity,
  params: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table name" },
      codigo: { type: "string", description: "Supplier code" },
    },
    required: ["table", "codigo"],
  },
  response: {
    200: {
      description: "Record data",
      type: "object",
      properties: {
        table: { type: "string" },
        codigo: { type: "string" },
        storeKind: { type: "string", enum: ["single", "array"] },
        data: {},
      },
    },
    ...storeErrorResponses,
  },
};

export const storeSearchSchema = {
  tags: ["Store Viewer"],
  summary: "Search codigos",
  description:
    "Searches for codigos containing the given substring across all tables. Returns up to 200 results.",
  security: storeViewerSecurity,
  querystring: {
    type: "object",
    properties: {
      q: { type: "string", description: "Substring to search for in codigos" },
    },
    required: ["q"],
  },
  response: {
    200: {
      description: "Search results",
      type: "object",
      properties: {
        query: { type: "string" },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              table: { type: "string" },
              codigo: { type: "string" },
            },
          },
        },
        total: { type: "number" },
      },
    },
    400: { description: "Missing query parameter", ...ErrorResponse },
    401: storeErrorResponses[401],
  },
};
