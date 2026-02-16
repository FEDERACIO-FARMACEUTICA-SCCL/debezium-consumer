import { loadConfig } from "./config";
import { initLogger, logger } from "./logger";
import { PayloadRegistry } from "./payloads/payload-builder";
import { SupplierBuilder } from "./payloads/supplier";
import { SupplierContactBuilder } from "./payloads/supplier-contact";
import { AgreementBuilder } from "./payloads/agreement";
import { SnapshotTracker } from "./kafka/snapshot-tracker";
import { createMessageHandler } from "./kafka/message-handler";
import { createKafkaConsumer, KafkaConsumerHandle } from "./kafka/consumer";
import { HttpDispatcher } from "./dispatch/dispatcher";
import { ApiClient } from "./dispatch/http-client";
import { CdcDebouncer } from "./dispatch/cdc-debouncer";
import { startRetryLoop, stopRetryLoop } from "./dispatch/pending-buffer";
import { BulkService } from "./bulk/bulk-service";
import { SupplierBulkHandler } from "./bulk/handlers/supplier-handler";
import { ContactBulkHandler } from "./bulk/handlers/contact-handler";
import { AgreementBulkHandler } from "./bulk/handlers/agreement-handler";
import { startServer } from "./http/server";
import { computeRegistryHash } from "./domain/table-registry";
import { initStore, store } from "./domain/store";
import type { FastifyInstance } from "fastify";

async function main() {
  // 1. Configuration
  const config = loadConfig();

  // 2. Logger (must come after config)
  initLogger(config.logLevel);

  logger.info({ topics: config.kafka.topics }, "Starting Informix CDC Consumer");

  // 3. Initialize SQLite store
  initStore(config.store.dbPath);

  const registryHash = computeRegistryHash();
  const savedHash = store.getRegistryHash();

  if (config.store.forceRebuild) {
    logger.info({ tag: "Store" }, "FORCE_REBUILD=true, clearing store");
    store.clear();
  } else if (savedHash && savedHash !== registryHash) {
    logger.warn({ tag: "Store" }, "Registry changed, clearing store");
    store.clear();
  }
  store.setRegistryHash(registryHash);

  // Resume offsets from SQLite
  const resumeOffsets = store.getAllOffsets();
  const resumedFromSnapshot = resumeOffsets.size > 0;

  if (resumedFromSnapshot) {
    const stats = store.getStats();
    logger.info(
      { tag: "Store", stats, offsetCount: resumeOffsets.size },
      "Resuming from persisted store"
    );
  }

  // 4. Payload registry
  const registry = new PayloadRegistry();
  registry.register(new SupplierBuilder());
  registry.register(new SupplierContactBuilder());
  registry.register(new AgreementBuilder());

  // 5. API client + Dispatcher
  const apiClient = new ApiClient(config.api);
  const dispatcher = new HttpDispatcher(apiClient);

  // 5b. Bulk operations + HTTP trigger server
  let server: FastifyInstance | null = null;
  if (config.http.enabled) {
    const bulkService = new BulkService(apiClient, config.bulk.batchSize);
    bulkService.registerHandler(new SupplierBulkHandler(registry));
    bulkService.registerHandler(new ContactBulkHandler(registry));
    bulkService.registerHandler(new AgreementBulkHandler(registry));
    server = await startServer({
      port: config.http.port,
      apiKey: config.http.apiKey,
      bulkService,
    });
  }

  // 6. CDC debouncer
  const debouncer = new CdcDebouncer(
    registry,
    dispatcher,
    config.debounce.windowMs,
    config.debounce.maxBufferSize,
    config.bulk.batchSize
  );

  // 7. Snapshot tracker
  const snapshotTracker = new SnapshotTracker(
    config.kafka.topics,
    resumedFromSnapshot
  );

  // 8. Message handler
  let kafkaConsumer: KafkaConsumerHandle | null = null;

  const messageHandler = createMessageHandler({
    config,
    payloadRegistry: registry,
    snapshotTracker,
    debouncer,
    resumedFromSnapshot,
    onReSnapshotDetected: () => {
      store.clear();
      store.clearOffsets();
      kafkaConsumer?.seekAllToBeginning();
    },
    onStoreReady: () => {
      // No delay needed — SQLite persists each write immediately
      logger.info({ tag: "Store" }, "Store ready (rebuild complete)");
    },
  });

  // 9. Kafka consumer
  kafkaConsumer = await createKafkaConsumer(
    config,
    messageHandler,
    (key, offset) => store.setOffset(key, offset),
    resumeOffsets
  );
  const consumer = kafkaConsumer;

  // 10. Retry loop for incomplete payloads
  startRetryLoop(registry, dispatcher);

  // 11. Graceful shutdown
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
        store.close();
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
