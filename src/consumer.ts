import { KafkaJS } from "@confluentinc/kafka-javascript";
import { AppConfig } from "./config";
import { DebeziumEvent, OP_LABELS } from "./types/debezium";
import { detectChanges } from "./watched-fields";
import { updateStore, getStoreStats } from "./store";
import { buildSupplierPayload } from "./supplier";
import { buildSupplierContactPayload } from "./supplier-contact";
import { addPending, startRetryLoop } from "./pending-buffer";
import { logger } from "./logger";

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
  logger.info({ broker: config.kafka.brokers }, "Connected to Kafka");

  await consumer.subscribe({
    topics: config.kafka.topics,
  });
  logger.info(
    { topics: config.kafka.topics, groupId: ephemeralGroupId },
    "Subscribed to topics (ephemeral group, reads from beginning)"
  );

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
          logger.debug(
            { tag: "Consumer", topic, raw: JSON.stringify(raw).slice(0, 200) },
            "Non-CDC message (skipped)"
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
            logger.info(
              { tag: "StoreRebuild", stats, eventsProcessed: snapshotLogCounter },
              "Store rebuild progress"
            );
          }

          // Track snapshot completion using Debezium's source.snapshot field
          // Debezium sends "last" only on the FINAL event of the entire snapshot (not per-topic).
          // So when we see "last", mark ALL topics as done.
          const snapshotFlag = String(event.source.snapshot ?? "false");
          if (snapshotFlag === "last") {
            for (const t of allTopics) topicSnapshotDone.add(t);
            logger.info(
              { tag: "StoreRebuild", topic },
              "All topics snapshot complete (snapshot 'last' received)"
            );
          } else if (event.op !== "r" && !topicSnapshotDone.has(topic)) {
            topicSnapshotDone.add(topic);
            logger.info(
              { tag: "StoreRebuild", topic, done: topicSnapshotDone.size, total: allTopics.size },
              "Topic snapshot complete"
            );
          }

          // Only mark store as ready when ALL subscribed topics have finished snapshot
          if (!storeReady && topicSnapshotDone.size >= allTopics.size) {
            storeReady = true;
            const stats = getStoreStats();
            logger.info(
              { tag: "StoreRebuild", stats, eventsReplayed: snapshotLogCounter },
              "Store rebuild complete"
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

        logger.info(
          { tag: "CDC", op: label, table, timestamp, topic, partition },
          `${label} on ${table}`
        );

        // 2. Check if watched fields changed
        const changes = detectChanges(event);

        if (!changes) {
          logger.debug({ tag: "CDC", table }, "No watched fields changed, skipping");
          return;
        }

        if (config.logLevel === "debug") {
          logger.debug(
            { tag: "Watch", op: label, table: changes.table, changes: changes.changedFields },
            `${changes.changedFields.length} watched field(s) changed`
          );
        } else {
          logger.info(
            { tag: "Watch", op: label, table: changes.table, fields: changes.changedFields.map((c) => c.field) },
            `${changes.changedFields.length} watched field(s) changed`
          );
        }

        // 3. Extract codigo and build payloads
        const record = event.after ?? event.before;
        const codigo = String(record?.["codigo"] ?? "").trim();

        if (!codigo) {
          logger.debug({ tag: "CDC", table }, "No 'codigo' found in event, skipping payload build");
          return;
        }

        // Supplier payload (ctercero, gproveed)
        if (SUPPLIER_TABLES.has(tableLower)) {
          const supplierPayload = buildSupplierPayload(codigo);
          if (supplierPayload) {
            logger.info({ tag: "Supplier", codigo }, "Payload built");
            logger.debug({ tag: "Supplier", codigo, payload: supplierPayload }, "Supplier payload details");
            // TODO: enviar supplierPayload a la API REST
          } else {
            addPending(codigo, "supplier");
          }
        }

        // Supplier_Contacts payload (ctercero, gproveed, cterdire)
        if (CONTACT_TABLES.has(tableLower)) {
          const contactPayload = buildSupplierContactPayload(codigo);
          if (contactPayload) {
            logger.info({ tag: "SupplierContact", codigo }, "Payload built");
            logger.debug({ tag: "SupplierContact", codigo, payload: contactPayload }, "SupplierContact payload details");
            // TODO: enviar contactPayload a la API REST
          } else {
            addPending(codigo, "contact");
          }
        }
      } catch (err) {
        logger.error({ tag: "Consumer", topic, err }, "Error processing message");
      }
    },
  });

  return consumer;
}
