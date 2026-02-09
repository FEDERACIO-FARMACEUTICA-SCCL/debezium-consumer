import { KafkaJS } from "@confluentinc/kafka-javascript";
import { AppConfig } from "./config";
import { DebeziumEvent, OP_LABELS } from "./types/debezium";
import { detectChanges } from "./watched-fields";
import { updateStore, getStoreStats } from "./store";
import { buildSupplierPayload } from "./supplier";
import { buildSupplierContactPayload } from "./supplier-contact";

// Tables that feed each payload
const SUPPLIER_TABLES = new Set(["ctercero", "gproveed"]);
const CONTACT_TABLES = new Set(["ctercero", "gproveed", "cterdire"]);

export async function createConsumer(config: AppConfig) {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: {
      brokers: [config.kafka.brokers],
    },
  });

  // Ephemeral group ID: always read from beginning to rebuild the in-memory store
  const ephemeralGroupId = `${config.kafka.groupId}-${Date.now()}`;

  const consumer = kafka.consumer({
    kafkaJS: {
      groupId: ephemeralGroupId,
      fromBeginning: true,
      autoCommit: false,
    },
  });

  await consumer.connect();
  console.log(`[Consumer] Connected to Kafka at ${config.kafka.brokers}`);

  await consumer.subscribe({
    topics: config.kafka.topics,
  });
  console.log(
    `[Consumer] Subscribed to topics: ${config.kafka.topics.join(", ")}`
  );
  console.log(`[Consumer] Using ephemeral group: ${ephemeralGroupId} (reads from beginning)`);

  let snapshotLogCounter = 0;
  let storeReady = false;

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      if (!message.value) return;

      try {
        const raw = JSON.parse(message.value.toString());

        // Debezium envía schema+payload; extraer el payload
        const payload = raw.payload ?? raw;

        if (!payload.op || !payload.source) {
          console.log(
            `[Consumer] Non-CDC message on ${topic}:`,
            JSON.stringify(raw).slice(0, 200)
          );
          return;
        }

        const event = payload as DebeziumEvent;
        const table = event.source.table;
        const tableLower = table.toLowerCase();
        const label = OP_LABELS[event.op] ?? event.op;

        // 1. Update in-memory store (always, for all events on relevant tables)
        updateStore(table, event.op, event.before, event.after);

        // During snapshot/replay, only update store — don't process as live CDC
        if (event.op === "r" || !storeReady) {
          snapshotLogCounter++;
          if (snapshotLogCounter % 1000 === 0) {
            const stats = getStoreStats();
            console.log(
              `[Store rebuild] Progress: ${JSON.stringify(stats)} (${snapshotLogCounter} events processed)`
            );
          }
          // First live event (non-snapshot) signals the store is fully loaded
          if (event.op !== "r" && !storeReady) {
            storeReady = true;
            const stats = getStoreStats();
            console.log(
              `[Store rebuild] Complete: ${JSON.stringify(stats)} (${snapshotLogCounter} events replayed)`
            );
            snapshotLogCounter = 0;
            // Fall through to process this live event
          } else {
            return;
          }
        }

        const timestamp = event.ts_ms
          ? new Date(event.ts_ms).toISOString()
          : "N/A";

        console.log(
          `[CDC] ${label} on ${table} at ${timestamp} (topic: ${topic}, partition: ${partition})`
        );

        // 2. Check if watched fields changed
        const changes = detectChanges(event);

        if (!changes) {
          console.log(`  No watched fields changed, skipping.`);
          return;
        }

        console.log(
          `[WATCH] ${label} on ${changes.table} — ${changes.changedFields.length} field(s) changed:`
        );
        for (const ch of changes.changedFields) {
          console.log(
            `  ${ch.field}: ${JSON.stringify(ch.before)} → ${JSON.stringify(ch.after)}`
          );
        }

        // 3. Extract codigo and build payloads
        const record = event.after ?? event.before;
        const codigo = String(record?.["codigo"] ?? "").trim();

        if (!codigo) {
          console.log(`  No 'codigo' found in event, skipping payload build.`);
          return;
        }

        // Supplier payload (ctercero, gproveed)
        if (SUPPLIER_TABLES.has(tableLower)) {
          const supplierPayload = buildSupplierPayload(codigo);
          if (supplierPayload) {
            console.log(
              `[Supplier] Payload:`,
              JSON.stringify(supplierPayload, null, 2)
            );
            // TODO: enviar supplierPayload a la API REST
          }
        }

        // Supplier_Contacts payload (ctercero, gproveed, cterdire)
        if (CONTACT_TABLES.has(tableLower)) {
          const contactPayload = buildSupplierContactPayload(codigo);
          if (contactPayload) {
            console.log(
              `[SupplierContact] Payload:`,
              JSON.stringify(contactPayload, null, 2)
            );
            // TODO: enviar contactPayload a la API REST
          }
        }
      } catch (err) {
        console.error(`[Consumer] Error processing message:`, err);
      }
    },
  });

  return consumer;
}
