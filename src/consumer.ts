import { KafkaJS } from "@confluentinc/kafka-javascript";
import { AppConfig } from "./config";
import { DebeziumEvent, OP_LABELS } from "./types/debezium";
import { detectChanges } from "./watched-fields";
import { updateStore, getStoreStats } from "./store";
import { buildSupplierPayload } from "./supplier";
import { buildSupplierContactPayload } from "./supplier-contact";
import { addPending, startRetryLoop } from "./pending-buffer";

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

  // Start retry loop for incomplete payloads (queued codigos retried periodically)
  startRetryLoop(config);

  let snapshotLogCounter = 0;
  let storeReady = false;

  // Track snapshot completion per topic — storeReady only when ALL topics are done
  const topicSnapshotDone = new Set<string>();
  const allTopics = new Set(config.kafka.topics);

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

          // Track snapshot completion using Debezium's source.snapshot field
          // Debezium sends "last" only on the FINAL event of the entire snapshot (not per-topic).
          // So when we see "last", mark ALL topics as done.
          const snapshotFlag = String(event.source.snapshot ?? "false");
          if (snapshotFlag === "last") {
            for (const t of allTopics) topicSnapshotDone.add(t);
            console.log(
              `[Store rebuild] All topics snapshot complete (snapshot "last" received on ${topic})`
            );
          } else if (event.op !== "r" && !topicSnapshotDone.has(topic)) {
            topicSnapshotDone.add(topic);
            console.log(
              `[Store rebuild] Topic ${topic} snapshot complete (${topicSnapshotDone.size}/${allTopics.size})`
            );
          }

          // Only mark store as ready when ALL subscribed topics have finished snapshot
          if (!storeReady && topicSnapshotDone.size >= allTopics.size) {
            storeReady = true;
            const stats = getStoreStats();
            console.log(
              `[Store rebuild] Complete: ${JSON.stringify(stats)} (${snapshotLogCounter} events replayed)`
            );
            snapshotLogCounter = 0;

            // If this event is a snapshot event, don't process it as live
            if (event.op === "r") return;
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
        if (config.logLevel === "debug") {
          for (const ch of changes.changedFields) {
            console.log(
              `  ${ch.field}: ${JSON.stringify(ch.before)} → ${JSON.stringify(ch.after)}`
            );
          }
        } else {
          console.log(
            `  Changed fields: ${changes.changedFields.map((c) => c.field).join(", ")}`
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
            if (config.logLevel === "debug") {
              console.log(
                `[Supplier] Payload:`,
                JSON.stringify(supplierPayload, null, 2)
              );
            } else {
              console.log(`[Supplier] Payload built for codigo=${codigo}`);
            }
            // TODO: enviar supplierPayload a la API REST
          } else {
            addPending(codigo, "supplier");
          }
        }

        // Supplier_Contacts payload (ctercero, gproveed, cterdire)
        if (CONTACT_TABLES.has(tableLower)) {
          const contactPayload = buildSupplierContactPayload(codigo);
          if (contactPayload) {
            if (config.logLevel === "debug") {
              console.log(
                `[SupplierContact] Payload:`,
                JSON.stringify(contactPayload, null, 2)
              );
            } else {
              console.log(`[SupplierContact] Payload built for codigo=${codigo}`);
            }
            // TODO: enviar contactPayload a la API REST
          } else {
            addPending(codigo, "contact");
          }
        }
      } catch (err) {
        console.error(`[Consumer] Error processing message:`, err);
      }
    },
  });

  return consumer;
}
