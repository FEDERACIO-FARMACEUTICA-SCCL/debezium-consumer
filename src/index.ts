import { loadConfig } from "./config";
import { createConsumer } from "./consumer";
import { stopRetryLoop } from "./pending-buffer";

async function main() {
  const config = loadConfig();

  console.log("[App] Starting Informix CDC Consumer...");
  console.log(`[App] Topics: ${config.kafka.topics.join(", ")}`);

  const consumer = await createConsumer(config);

  const shutdown = async (signal: string) => {
    console.log(`\n[App] Received ${signal}, shutting down...`);
    try {
      stopRetryLoop();
      await consumer.disconnect();
      console.log("[App] Consumer disconnected.");
    } catch (err) {
      console.error("[App] Error during shutdown:", err);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[App] Fatal error:", err);
  process.exit(1);
});
