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
