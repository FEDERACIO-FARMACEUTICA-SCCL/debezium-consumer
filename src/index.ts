import { loadConfig } from "./config";
import { initLogger, logger } from "./logger";
import { PayloadRegistry } from "./payloads/payload-builder";
import { SupplierBuilder } from "./payloads/supplier";
import { SupplierContactBuilder } from "./payloads/supplier-contact";
import { SnapshotTracker } from "./kafka/snapshot-tracker";
import { createMessageHandler } from "./kafka/message-handler";
import {
  createKafkaConsumer,
  OffsetTracker,
  KafkaConsumerHandle,
} from "./kafka/consumer";
import { HttpDispatcher } from "./dispatch/dispatcher";
import { ApiClient } from "./dispatch/http-client";
import { CdcDebouncer } from "./dispatch/cdc-debouncer";
import { startRetryLoop, stopRetryLoop } from "./dispatch/pending-buffer";
import { BulkService } from "./bulk/bulk-service";
import { SupplierBulkHandler } from "./bulk/handlers/supplier-handler";
import { ContactBulkHandler } from "./bulk/handlers/contact-handler";
import { startServer } from "./http/server";
import { computeRegistryHash } from "./domain/table-registry";
import { store } from "./domain/store";
import {
  saveSnapshot,
  loadSnapshot,
  deleteSnapshot,
} from "./persistence/snapshot-manager";
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
    const bulkService = new BulkService(apiClient, config.bulk.batchSize);
    bulkService.registerHandler(new SupplierBulkHandler(registry));
    bulkService.registerHandler(new ContactBulkHandler(registry));
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

  // 6. Snapshot persistence — try to load
  const registryHash = computeRegistryHash();
  let resumeOffsets: Map<string, string> | undefined;
  let resumedFromSnapshot = false;

  if (config.snapshot.forceRebuild) {
    logger.info({ tag: "Snapshot" }, "FORCE_REBUILD=true, skipping snapshot load");
    deleteSnapshot(config.snapshot.path);
  } else {
    const snapshot = loadSnapshot(config.snapshot.path, registryHash);
    if (snapshot) {
      store.hydrate(snapshot.store);
      resumeOffsets = snapshot.offsets;
      resumedFromSnapshot = true;
      const stats = store.getStats();
      logger.info(
        { tag: "Snapshot", stats },
        "Store hydrated from snapshot"
      );
    }
  }

  // 7. Offset tracker + snapshot save helper
  const offsetTracker = new OffsetTracker();

  const persistSnapshot = () => {
    try {
      const offsets = offsetTracker.getAll();
      if (offsets.size > 0) {
        saveSnapshot(
          config.snapshot.path,
          registryHash,
          offsets,
          store.serialize()
        );
      }
    } catch (err) {
      logger.error({ tag: "Snapshot", err }, "Failed to save snapshot");
    }
  };

  // 8. Snapshot tracker
  const snapshotTracker = new SnapshotTracker(
    config.kafka.topics,
    resumedFromSnapshot
  );

  // 9. Message handler
  // Use mutable ref so onReSnapshotDetected can call seekAllToBeginning()
  let kafkaConsumer: KafkaConsumerHandle | null = null;

  const messageHandler = createMessageHandler({
    config,
    payloadRegistry: registry,
    snapshotTracker,
    debouncer,
    resumedFromSnapshot,
    onReSnapshotDetected: () => {
      deleteSnapshot(config.snapshot.path);
      kafkaConsumer?.seekAllToBeginning();
    },
    onStoreReady: () => {
      // Delay to allow remaining snapshot events across all topics to drain.
      // The tracker fires onStoreReady when "snapshot: last" arrives, but
      // events from other topics may still be pending in Kafka.
      setTimeout(() => persistSnapshot(), 30_000);
    },
  });

  // 10. Kafka consumer
  kafkaConsumer = await createKafkaConsumer(
    config,
    messageHandler,
    offsetTracker,
    resumeOffsets
  );
  const consumer = kafkaConsumer;

  // 11. Periodic snapshot save (every 5 min)
  const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
  const snapshotInterval = setInterval(() => {
    if (snapshotTracker.ready) persistSnapshot();
  }, SNAPSHOT_INTERVAL_MS);

  // 12. Retry loop for incomplete payloads
  startRetryLoop(registry, dispatcher);

  // 13. Graceful shutdown
  const SHUTDOWN_TIMEOUT_MS = 10_000;
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal");
    clearInterval(snapshotInterval);
    let exitCode = 0;
    try {
      const graceful = async () => {
        stopRetryLoop();
        await debouncer.stop();
        persistSnapshot();
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
