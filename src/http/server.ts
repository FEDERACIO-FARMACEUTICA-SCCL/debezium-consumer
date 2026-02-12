import { timingSafeEqual } from "crypto";
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { logger } from "../logger";
import { BulkService, BulkOperationInProgressError } from "../bulk/bulk-service";
import { ENTITY_REGISTRY } from "../domain/entity-registry";
import { healthSchema, makeTriggerSchema } from "./schemas";
import { registerStoreViewer } from "./store-viewer";

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
    if (request.url === "/health" || request.url.startsWith("/docs") || request.url === "/store") return;

    const auth = request.headers.authorization ?? "";
    const expected = `Bearer ${opts.apiKey}`;
    const isValid =
      auth.length === expected.length &&
      timingSafeEqual(Buffer.from(auth), Buffer.from(expected));

    if (!isValid) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
  });

  // Health check
  app.get("/health", { schema: healthSchema }, async () => {
    return { status: "ok" };
  });

  // Dynamic trigger routes from entity registry
  for (const entity of ENTITY_REGISTRY) {
    app.post(`/triggers/${entity.triggerPath}`, {
      schema: makeTriggerSchema(entity.swagger.sync),
    }, async (request, reply) => {
      const { CodSupplier } = (request.body as TriggerBody) ?? {};
      return handleBulk(reply, () => opts.bulkService.sync(entity.type, CodSupplier));
    });

    app.delete(`/triggers/${entity.triggerPath}`, {
      schema: makeTriggerSchema(entity.swagger.delete),
    }, async (request, reply) => {
      const { CodSupplier } = (request.body as TriggerBody) ?? {};
      return handleBulk(reply, () => opts.bulkService.delete(entity.type, CodSupplier));
    });
  }

  // Store viewer (HTML page + API endpoints)
  registerStoreViewer(app);

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
