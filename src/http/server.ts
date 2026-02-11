import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { logger } from "../logger";
import { BulkService, BulkOperationInProgressError } from "../bulk/bulk-service";
import {
  healthSchema,
  syncSuppliersSchema,
  syncContactsSchema,
  deleteSuppliersSchema,
  deleteContactsSchema,
} from "./schemas";

interface TriggerBody {
  CodSupplier?: string[];
}

export interface ServerOptions {
  port: number;
  apiKey: string;
  bulkService: BulkService;
}

export async function startServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    requestTimeout: 600_000,
  });

  // 1. Swagger plugin (must register before routes)
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Informix Consumer — Trigger API",
        description:
          "Bulk operations for syncing and deleting suppliers/contacts via the ingest API.",
        version: "1.0.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "Static API key configured via TRIGGER_API_KEY env var",
          },
        },
      },
    },
  });

  // 2. Swagger UI
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      persistAuthorization: true,
    },
  });

  // 3. Auth hook — skip for /health and /docs*
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === "/health" || request.url.startsWith("/docs")) return;

    const auth = request.headers.authorization;
    if (!auth || auth !== `Bearer ${opts.apiKey}`) {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });

  // Health check
  app.get("/health", { schema: healthSchema }, async () => {
    return { status: "ok" };
  });

  // Trigger routes
  app.post("/triggers/sync/suppliers", { schema: syncSuppliersSchema }, async (request, reply) => {
    const { CodSupplier } = (request.body as TriggerBody) ?? {};
    return handleBulk(reply, () => opts.bulkService.syncSuppliers(CodSupplier));
  });

  app.post("/triggers/sync/contacts", { schema: syncContactsSchema }, async (request, reply) => {
    const { CodSupplier } = (request.body as TriggerBody) ?? {};
    return handleBulk(reply, () => opts.bulkService.syncContacts(CodSupplier));
  });

  app.post("/triggers/delete/suppliers", { schema: deleteSuppliersSchema }, async (request, reply) => {
    const { CodSupplier } = (request.body as TriggerBody) ?? {};
    return handleBulk(reply, () => opts.bulkService.deleteSuppliers(CodSupplier));
  });

  app.post("/triggers/delete/contacts", { schema: deleteContactsSchema }, async (request, reply) => {
    const { CodSupplier } = (request.body as TriggerBody) ?? {};
    return handleBulk(reply, () => opts.bulkService.deleteContacts(CodSupplier));
  });

  await app.listen({ port: opts.port, host: "0.0.0.0" });
  logger.info({ tag: "HTTP", port: opts.port }, `Trigger server listening on port ${opts.port}`);

  return app;
}

async function handleBulk(
  reply: FastifyReply,
  fn: () => Promise<unknown>
): Promise<void> {
  try {
    const result = await fn();
    reply.code(200).send(result);
  } catch (err) {
    if (err instanceof BulkOperationInProgressError) {
      reply.code(409).send({ error: err.message });
    } else {
      logger.error({ tag: "HTTP", err }, "Trigger handler error");
      reply.code(500).send({ error: "Internal server error" });
    }
  }
}
