export interface AppConfig {
  kafka: {
    brokers: string;
    groupId: string;
    topics: string[];
    autoOffsetReset: string;
  };
  logLevel: "info" | "debug";
}

const DEFAULT_TOPICS = [
  "informix.informix.ctercero",
  "informix.informix.cterdire",
  // "informix.informix.ff_fcloud_tercero",
  "informix.informix.gproveed",
].join(",");

export function loadConfig(): AppConfig {
  const logLevel = process.env.LOG_LEVEL ?? "info";
  return {
    kafka: {
      brokers: process.env.KAFKA_BROKERS ?? "kafka:29092",
      groupId: process.env.KAFKA_GROUP_ID ?? "informix-consumer",
      topics: (process.env.KAFKA_TOPICS ?? DEFAULT_TOPICS)
        .split(",")
        .map((t) => t.trim()),
      autoOffsetReset: process.env.KAFKA_AUTO_OFFSET_RESET ?? "earliest",
    },
    logLevel: logLevel === "debug" ? "debug" : "info",
  };
}
