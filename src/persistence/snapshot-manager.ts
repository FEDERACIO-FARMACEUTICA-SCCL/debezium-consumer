import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../logger";
import { SerializedStore } from "../domain/store";

const SNAPSHOT_VERSION = 1;

export interface SnapshotFile {
  version: number;
  registryHash: string;
  timestamp: string;
  offsets: Record<string, string>;
  store: SerializedStore;
}

export interface SnapshotData {
  offsets: Map<string, string>;
  store: SerializedStore;
}

export function saveSnapshot(
  path: string,
  registryHash: string,
  offsets: Map<string, string>,
  storeData: SerializedStore
): void {
  const file: SnapshotFile = {
    version: SNAPSHOT_VERSION,
    registryHash,
    timestamp: new Date().toISOString(),
    offsets: Object.fromEntries(offsets),
    store: storeData,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file));
  logger.info(
    { tag: "Snapshot", path, offsetCount: offsets.size },
    "Store snapshot saved"
  );
}

export function loadSnapshot(
  path: string,
  registryHash: string
): SnapshotData | null {
  if (!existsSync(path)) {
    logger.info({ tag: "Snapshot", path }, "No snapshot file found");
    return null;
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const file: SnapshotFile = JSON.parse(raw);

    if (file.version !== SNAPSHOT_VERSION) {
      logger.warn(
        { tag: "Snapshot", expected: SNAPSHOT_VERSION, got: file.version },
        "Snapshot version mismatch, discarding"
      );
      deleteSnapshot(path);
      return null;
    }

    if (file.registryHash !== registryHash) {
      logger.warn(
        { tag: "Snapshot" },
        "Registry hash mismatch (tables changed), discarding snapshot"
      );
      deleteSnapshot(path);
      return null;
    }

    const offsets = new Map(Object.entries(file.offsets));

    logger.info(
      {
        tag: "Snapshot",
        path,
        savedAt: file.timestamp,
        offsetCount: offsets.size,
      },
      "Snapshot loaded successfully"
    );

    return { offsets, store: file.store };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { tag: "Snapshot", error: msg },
      "Failed to load snapshot, discarding"
    );
    deleteSnapshot(path);
    return null;
  }
}

export function deleteSnapshot(path: string): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path);
      logger.info({ tag: "Snapshot", path }, "Snapshot file deleted");
    }
  } catch {
    // Best effort — ignore errors on delete
  }
}
