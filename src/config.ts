export interface AppConfig {
  kafka: {
    brokers: string;
    groupId: string;
    topics: string[];
    autoOffsetReset: string;
  };
}

const DEFAULT_TOPICS = [
  "informix.informix.ctercero",
  "informix.informix.cterdire",
  // "informix.informix.ff_fcloud_tercero",
  "informix.informix.gproveed",
].join(",");

export function loadConfig(): AppConfig {
  return {
    kafka: {
      brokers: process.env.KAFKA_BROKERS ?? "kafka:29092",
      groupId: process.env.KAFKA_GROUP_ID ?? "informix-consumer",
      topics: (process.env.KAFKA_TOPICS ?? DEFAULT_TOPICS)
        .split(",")
        .map((t) => t.trim()),
      autoOffsetReset: process.env.KAFKA_AUTO_OFFSET_RESET ?? "earliest",
    },
  };
}
