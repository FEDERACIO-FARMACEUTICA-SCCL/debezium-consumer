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
import { startRetryLoop, stopRetryLoop } from "./dispatch/pending-buffer";

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

  // 5. Snapshot tracker
  const snapshotTracker = new SnapshotTracker(config.kafka.topics);

  // 6. Message handler
  const messageHandler = createMessageHandler(
    config,
    registry,
    snapshotTracker,
    dispatcher
  );

  // 7. Kafka consumer
  const consumer = await createKafkaConsumer(config, messageHandler);

  // 8. Retry loop for incomplete payloads
  startRetryLoop(registry, dispatcher);

  // 9. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal");
    let exitCode = 0;
    try {
      stopRetryLoop();
      await consumer.disconnect();
      logger.info("Consumer disconnected");
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
