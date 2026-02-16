import { ALL_TOPICS } from "./domain/table-registry";

export interface AppConfig {
  kafka: {
    brokers: string;
    groupId: string;
    topics: string[];
    autoOffsetReset: string;
  };
  api: {
    baseUrl: string;
    username: string;
    password: string;
  };
  http: {
    port: number;
    enabled: boolean;
    apiKey: string;
  };
  bulk: {
    batchSize: number;
  };
  debounce: {
    windowMs: number;
    maxBufferSize: number;
  };
  store: {
    dbPath: string;
    forceRebuild: boolean;
  };
  logLevel: "info" | "debug";
}

export function loadConfig(): AppConfig {
  const logLevel = process.env.LOG_LEVEL ?? "info";
  const apiBaseUrl = process.env.INGEST_API_BASE_URL;
  const apiUsername = process.env.INGEST_API_USERNAME;
  const apiPassword = process.env.INGEST_API_PASSWORD;

  if (!apiBaseUrl || !apiUsername || !apiPassword) {
    throw new Error(
      "Missing required env vars: INGEST_API_BASE_URL, INGEST_API_USERNAME, INGEST_API_PASSWORD"
    );
  }

  const httpEnabled = process.env.HTTP_ENABLED === "true";
  const triggerApiKey = process.env.TRIGGER_API_KEY ?? "";

  if (httpEnabled && !triggerApiKey) {
    throw new Error(
      "TRIGGER_API_KEY is required when HTTP_ENABLED=true"
    );
  }

  return {
    kafka: {
      brokers: process.env.KAFKA_BROKERS ?? "kafka:29092",
      groupId: process.env.KAFKA_GROUP_ID ?? "informix-consumer",
      topics: (process.env.KAFKA_TOPICS ?? ALL_TOPICS.join(","))
        .split(",")
        .map((t) => t.trim()),
      autoOffsetReset: process.env.KAFKA_AUTO_OFFSET_RESET ?? "earliest",
    },
    api: {
      baseUrl: apiBaseUrl,
      username: apiUsername,
      password: apiPassword,
    },
    http: {
      port: Number(process.env.HTTP_PORT ?? 3001),
      enabled: httpEnabled,
      apiKey: triggerApiKey,
    },
    bulk: {
      batchSize: Number(process.env.BULK_BATCH_SIZE ?? 500),
    },
    debounce: {
      windowMs: Number(process.env.DEBOUNCE_WINDOW_MS ?? 1000),
      maxBufferSize: Number(process.env.DEBOUNCE_MAX_BUFFER_SIZE ?? 500),
    },
    store: {
      dbPath: process.env.STORE_DB_PATH ?? "./data/store.db",
      forceRebuild: process.env.FORCE_REBUILD === "true",
    },
    logLevel: logLevel === "debug" ? "debug" : "info",
  };
}
