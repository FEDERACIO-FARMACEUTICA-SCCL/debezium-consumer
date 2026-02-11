import { AppConfig } from "../config";
import { DebeziumEvent, OP_LABELS } from "../types/debezium";
import { FIELD_TO_PAYLOADS } from "../domain/table-registry";
import { PayloadType } from "../types/payloads";
import { updateStore, getStoreStats } from "../domain/store";
import { detectChanges } from "../domain/watched-fields";
import { PayloadRegistry } from "../payloads/payload-builder";
import { SnapshotTracker } from "./snapshot-tracker";
import { CdcDebouncer } from "../dispatch/cdc-debouncer";
import { logger } from "../logger";
import { MessageCallback } from "./consumer";

export function createMessageHandler(
  config: AppConfig,
  payloadRegistry: PayloadRegistry,
  snapshotTracker: SnapshotTracker,
  debouncer: CdcDebouncer
): MessageCallback {
  return async ({ topic, partition, message }) => {
    if (!message.value) return;

    try {
      const raw = JSON.parse(message.value.toString());

      const payload = raw.payload ?? raw;

      if (!payload.op || !payload.source) {
        logger.debug(
          {
            tag: "Consumer",
            topic,
            raw: JSON.stringify(raw).slice(0, 200),
          },
          "Non-CDC message (skipped)"
        );
        return;
      }

      const event = payload as DebeziumEvent;
      const table = event.source.table;
      const tableLower = table.toLowerCase();
      const label = OP_LABELS[event.op] ?? event.op;

      // 1. Update in-memory store (always, for all events)
      updateStore(table, event.op, event.before, event.after);

      // 2. Snapshot tracking
      const snapshotFlag = String(event.source.snapshot ?? "false");
      const isLive = snapshotTracker.processEvent(
        event.op,
        snapshotFlag,
        topic,
        getStoreStats
      );
      if (!isLive) return;

      const timestamp = event.ts_ms
        ? new Date(event.ts_ms).toISOString()
        : "N/A";

      logger.info(
        { tag: "CDC", op: label, table, timestamp, topic, partition },
        `${label} on ${table}`
      );

      // 3. Check if watched fields changed
      const changes = detectChanges(event);

      if (!changes) {
        logger.debug(
          { tag: "CDC", table },
          "No watched fields changed, skipping"
        );
        return;
      }

      if (config.logLevel === "debug") {
        logger.debug(
          {
            tag: "Watch",
            op: label,
            table: changes.table,
            changes: changes.changedFields,
          },
          `${changes.changedFields.length} watched field(s) changed`
        );
      } else {
        logger.info(
          {
            tag: "Watch",
            op: label,
            table: changes.table,
            fields: changes.changedFields.map((c) => c.field),
          },
          `${changes.changedFields.length} watched field(s) changed`
        );
      }

      // 4. Extract codigo and build payloads (data-driven)
      const record = event.after ?? event.before;
      const codigo = String(record?.["codigo"] ?? "").trim();

      if (!codigo) {
        logger.debug(
          { tag: "CDC", table },
          "No 'codigo' found in event, skipping payload build"
        );
        return;
      }

      // Compute payload types from the specific fields that changed
      const payloadTypes = new Set<PayloadType>();
      for (const c of changes.changedFields) {
        const key = `${tableLower}.${c.field}`;
        const types = FIELD_TO_PAYLOADS.get(key);
        if (types) for (const t of types) payloadTypes.add(t);
      }
      if (payloadTypes.size === 0) return;

      debouncer.enqueue(codigo, payloadTypes);
    } catch (err) {
      logger.error({ tag: "Consumer", topic, err }, "Error processing message");
    }
  };
}
