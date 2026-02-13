import { AppConfig } from "../config";
import { DebeziumEvent, OP_LABELS } from "../types/debezium";
import { FIELD_TO_PAYLOADS } from "../domain/table-registry";
import { PayloadType } from "../types/payloads";
import { updateStore, getStoreStats, store } from "../domain/store";
import { getAllowedTypes } from "../domain/codare-registry";
import { detectChanges } from "../domain/watched-fields";
import { PayloadRegistry } from "../payloads/payload-builder";
import { SnapshotTracker } from "./snapshot-tracker";
import { CdcDebouncer } from "../dispatch/cdc-debouncer";
import { logger } from "../logger";
import { MessageCallback } from "./consumer";

export interface MessageHandlerOptions {
  config: AppConfig;
  payloadRegistry: PayloadRegistry;
  snapshotTracker: SnapshotTracker;
  debouncer: CdcDebouncer;
  /** If true, we resumed from a snapshot — detect re-snapshots. */
  resumedFromSnapshot?: boolean;
  /** Called when a Debezium re-snapshot is detected after resume. */
  onReSnapshotDetected?: () => void;
  /** Called once when the store becomes ready (rebuild complete). */
  onStoreReady?: () => void;
}

export function createMessageHandler(opts: MessageHandlerOptions): MessageCallback;
/** @deprecated Use options object overload */
export function createMessageHandler(
  config: AppConfig,
  payloadRegistry: PayloadRegistry,
  snapshotTracker: SnapshotTracker,
  debouncer: CdcDebouncer
): MessageCallback;
export function createMessageHandler(
  configOrOpts: AppConfig | MessageHandlerOptions,
  payloadRegistry?: PayloadRegistry,
  snapshotTracker?: SnapshotTracker,
  debouncer?: CdcDebouncer
): MessageCallback {
  // Normalize to options object
  const opts: MessageHandlerOptions =
    "config" in configOrOpts
      ? configOrOpts
      : {
          config: configOrOpts,
          payloadRegistry: payloadRegistry!,
          snapshotTracker: snapshotTracker!,
          debouncer: debouncer!,
        };

  const {
    config,
    payloadRegistry: registry,
    snapshotTracker: tracker,
    debouncer: deb,
    resumedFromSnapshot,
    onReSnapshotDetected,
    onStoreReady,
  } = opts;

  let reSnapshotHandled = false;
  let storeReadyFired = false;

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

      // Detect Debezium re-snapshot after resuming from persisted snapshot
      if (
        resumedFromSnapshot &&
        !reSnapshotHandled &&
        event.op === "r"
      ) {
        reSnapshotHandled = true;
        logger.warn(
          { tag: "Snapshot", topic },
          "Debezium re-snapshot detected after resume — clearing store and rebuilding"
        );
        store.clear();
        tracker.reset();
        storeReadyFired = false;
        onReSnapshotDetected?.();
      }

      // 1. Update in-memory store (always, for all events)
      updateStore(table, event.op, event.before, event.after);

      // 2. Snapshot tracking
      const snapshotFlag = String(event.source.snapshot ?? "false");
      const isLive = tracker.processEvent(
        event.op,
        snapshotFlag,
        topic,
        getStoreStats
      );
      if (!isLive) return;

      // Fire onStoreReady once when transitioning to live mode
      if (!storeReadyFired) {
        storeReadyFired = true;
        onStoreReady?.();
      }

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

      // Filter by codare (business type) — only allowed types pass through
      const cterceroRec = store.getSingle("ctercero", codigo);
      if (cterceroRec) {
        const allowed = getAllowedTypes(cterceroRec["codare"] as string);
        for (const t of [...payloadTypes]) {
          if (!allowed.has(t)) payloadTypes.delete(t);
        }
        if (payloadTypes.size === 0) return;
      }

      deb.enqueue(codigo, payloadTypes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ tag: "Consumer", topic, error: msg }, "Error processing message");
      logger.debug({ tag: "Consumer", topic, err }, "Error details");
    }
  };
}
