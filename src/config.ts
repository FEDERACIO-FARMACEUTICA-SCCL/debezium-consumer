import { ALL_TOPICS } from "./domain/table-registry";

export interface AppConfig {
  kafka: {
    brokers: string;
    groupId: string;
    topics: string[];
    autoOffsetReset: string;
  };
  http: {
    port: number;
    enabled: boolean;
  };
  logLevel: "info" | "debug";
}

export function loadConfig(): AppConfig {
  const logLevel = process.env.LOG_LEVEL ?? "info";
  return {
    kafka: {
      brokers: process.env.KAFKA_BROKERS ?? "kafka:29092",
      groupId: process.env.KAFKA_GROUP_ID ?? "informix-consumer",
      topics: (process.env.KAFKA_TOPICS ?? ALL_TOPICS.join(","))
        .split(",")
        .map((t) => t.trim()),
      autoOffsetReset: process.env.KAFKA_AUTO_OFFSET_RESET ?? "earliest",
    },
    http: {
      port: Number(process.env.HTTP_PORT ?? 3001),
      enabled: process.env.HTTP_ENABLED === "true",
    },
    logLevel: logLevel === "debug" ? "debug" : "info",
  };
}
