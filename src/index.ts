import { loadConfig } from "./config";
import { initLogger, logger } from "./logger";
import { PayloadRegistry } from "./payloads/payload-builder";
import { SupplierBuilder } from "./payloads/supplier";
import { SupplierContactBuilder } from "./payloads/supplier-contact";
import { SnapshotTracker } from "./kafka/snapshot-tracker";
import { createMessageHandler } from "./kafka/message-handler";
import { createKafkaConsumer } from "./kafka/consumer";
import { HttpDispatcher } from "./dispatch/dispatcher";
import { ApiClient } from "./dispatch/http-client";
import { CdcDebouncer } from "./dispatch/cdc-debouncer";
import { startRetryLoop, stopRetryLoop } from "./dispatch/pending-buffer";
import { BulkService } from "./bulk/bulk-service";
import { startServer } from "./http/server";
import type { FastifyInstance } from "fastify";

async function main() {
  // 1. Configuration
  const config = loadConfig();

  // 2. Logger (must come after config)
  initLogger(config.logLevel);

  logger.info({ topics: config.kafka.topics }, "Starting Informix CDC Consumer");

  // 3. Payload registry
  const registry = new PayloadRegistry();
  registry.register(new SupplierBuilder());
  registry.register(new SupplierContactBuilder());

  // 4. API client + Dispatcher
  const apiClient = new ApiClient(config.api);
  const dispatcher = new HttpDispatcher(apiClient);

  // 4b. Bulk operations + HTTP trigger server
  let server: FastifyInstance | null = null;
  if (config.http.enabled) {
    const bulkService = new BulkService(apiClient, registry, config.bulk.batchSize);
    server = await startServer({
      port: config.http.port,
      apiKey: config.http.apiKey,
      bulkService,
    });
  }

  // 5. CDC debouncer
  const debouncer = new CdcDebouncer(
    registry,
    dispatcher,
    config.debounce.windowMs,
    config.debounce.maxBufferSize,
    config.bulk.batchSize
  );

  // 6. Snapshot tracker
  const snapshotTracker = new SnapshotTracker(config.kafka.topics);

  // 7. Message handler
  const messageHandler = createMessageHandler(
    config,
    registry,
    snapshotTracker,
    debouncer
  );

  // 8. Kafka consumer
  const consumer = await createKafkaConsumer(config, messageHandler);

  // 9. Retry loop for incomplete payloads
  startRetryLoop(registry, dispatcher);

  // 10. Graceful shutdown
  const SHUTDOWN_TIMEOUT_MS = 10_000;
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal");
    let exitCode = 0;
    try {
      const graceful = async () => {
        stopRetryLoop();
        await debouncer.stop();
        if (server) await server.close();
        await consumer.disconnect();
        logger.info("Consumer disconnected");
      };
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Shutdown timed out")), SHUTDOWN_TIMEOUT_MS)
      );
      await Promise.race([graceful(), timeout]);
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
      exitCode = 1;
    }
    process.exit(exitCode);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
