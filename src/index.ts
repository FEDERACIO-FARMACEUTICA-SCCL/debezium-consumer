import { loadConfig } from "./config";
import { createConsumer } from "./consumer";
import { stopRetryLoop } from "./pending-buffer";
import { logger } from "./logger";

async function main() {
  const config = loadConfig();

  logger.info({ topics: config.kafka.topics }, "Starting Informix CDC Consumer");

  const consumer = await createConsumer(config);

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
