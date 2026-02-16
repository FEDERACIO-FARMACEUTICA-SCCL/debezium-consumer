import Database, { Statement } from "better-sqlite3";
import { statSync } from "node:fs";
import { TableDefinition } from "./table-registry";

export type StoreRecord = Record<string, unknown>;

export class SqliteStore {
  private db: Database.Database;
  private storeKinds = new Map<string, "single" | "array">();
  private fieldFilters = new Map<string, Set<string>>();
  private keyFields = new Map<string, string>();

  // Prepared statements
  private stmtSingleUpsert: Statement;
  private stmtSingleGet: Statement;
  private stmtSingleDelete: Statement;
  private stmtSingleDeleteByTable: Statement;
  private stmtSingleCodigos: Statement;
  private stmtSingleCountByTable: Statement;

  private stmtArrayInsert: Statement;
  private stmtArrayGetByKey: Statement;
  private stmtArrayDeleteById: Statement;
  private stmtArrayUpdateById: Statement;
  private stmtArrayDeleteByTableKey: Statement;
  private stmtArrayDeleteByTable: Statement;
  private stmtArrayCodigos: Statement;
  private stmtArrayCountByTable: Statement;

  private stmtMetaUpsert: Statement;
  private stmtMetaGet: Statement;
  private stmtMetaDeleteByPrefix: Statement;

  constructor(dbPath: string, definitions: TableDefinition[]) {
    this.db = new Database(dbPath);

    // Performance pragmas
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -8000"); // 8MB cache

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS single_store (
        tbl  TEXT NOT NULL,
        key  TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (tbl, key)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS array_store (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        tbl  TEXT NOT NULL,
        key  TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_array_tbl_key ON array_store(tbl, key);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
    `);

    // Build definition lookups
    for (const def of definitions) {
      this.storeKinds.set(def.table, def.storeKind);
      if (def.storeFields?.length) {
        this.fieldFilters.set(def.table, new Set(def.storeFields));
      }
      this.keyFields.set(def.table, def.keyField ?? "codigo");
    }

    // Prepare statements
    this.stmtSingleUpsert = this.db.prepare(
      "INSERT OR REPLACE INTO single_store (tbl, key, data) VALUES (?, ?, ?)"
    );
    this.stmtSingleGet = this.db.prepare(
      "SELECT data FROM single_store WHERE tbl = ? AND key = ?"
    );
    this.stmtSingleDelete = this.db.prepare(
      "DELETE FROM single_store WHERE tbl = ? AND key = ?"
    );
    this.stmtSingleDeleteByTable = this.db.prepare(
      "DELETE FROM single_store WHERE tbl = ?"
    );
    this.stmtSingleCodigos = this.db.prepare(
      "SELECT key FROM single_store WHERE tbl = ?"
    );
    this.stmtSingleCountByTable = this.db.prepare(
      "SELECT tbl, COUNT(*) AS cnt FROM single_store GROUP BY tbl"
    );

    this.stmtArrayInsert = this.db.prepare(
      "INSERT INTO array_store (tbl, key, data) VALUES (?, ?, ?)"
    );
    this.stmtArrayGetByKey = this.db.prepare(
      "SELECT id, data FROM array_store WHERE tbl = ? AND key = ?"
    );
    this.stmtArrayDeleteById = this.db.prepare(
      "DELETE FROM array_store WHERE id = ?"
    );
    this.stmtArrayUpdateById = this.db.prepare(
      "UPDATE array_store SET data = ? WHERE id = ?"
    );
    this.stmtArrayDeleteByTableKey = this.db.prepare(
      "DELETE FROM array_store WHERE tbl = ? AND key = ?"
    );
    this.stmtArrayDeleteByTable = this.db.prepare(
      "DELETE FROM array_store WHERE tbl = ?"
    );
    this.stmtArrayCodigos = this.db.prepare(
      "SELECT DISTINCT key FROM array_store WHERE tbl = ?"
    );
    this.stmtArrayCountByTable = this.db.prepare(
      "SELECT tbl, COUNT(*) AS cnt FROM array_store GROUP BY tbl"
    );

    this.stmtMetaUpsert = this.db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
    );
    this.stmtMetaGet = this.db.prepare(
      "SELECT value FROM meta WHERE key = ?"
    );
    this.stmtMetaDeleteByPrefix = this.db.prepare(
      "DELETE FROM meta WHERE key LIKE ? || '%'"
    );
  }

  update(
    table: string,
    op: string,
    before: StoreRecord | null,
    after: StoreRecord | null
  ): void {
    const tableLower = table.toLowerCase();
    const fields = this.fieldFilters.get(tableLower);
    const filteredBefore = pickFields(before, fields);
    const filteredAfter = pickFields(after, fields);
    const keyField = this.keyFields.get(tableLower) ?? "codigo";
    const kind = this.storeKinds.get(tableLower);

    if (!kind) return;

    if (kind === "array") {
      this.updateArrayStore(tableLower, op, filteredBefore, filteredAfter, keyField);
      return;
    }

    // Single store
    if (op === "d") {
      const key = String(filteredBefore?.[keyField] ?? "").trim();
      if (key) this.stmtSingleDelete.run(tableLower, key);
    } else {
      const key = String(filteredAfter?.[keyField] ?? "").trim();
      if (key && filteredAfter) {
        this.stmtSingleUpsert.run(tableLower, key, JSON.stringify(filteredAfter));
      }
    }
  }

  getSingle(table: string, codigo: string): StoreRecord | undefined {
    const row = this.stmtSingleGet.get(table, codigo) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as StoreRecord) : undefined;
  }

  getArray(table: string, codigo: string): StoreRecord[] {
    const rows = this.stmtArrayGetByKey.all(table, codigo) as {
      id: number;
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as StoreRecord);
  }

  getAllCodigos(table: string): string[] {
    const kind = this.storeKinds.get(table);
    if (kind === "single") {
      const rows = this.stmtSingleCodigos.all(table) as { key: string }[];
      return rows.map((r) => r.key);
    }
    if (kind === "array") {
      const rows = this.stmtArrayCodigos.all(table) as { key: string }[];
      return rows.map((r) => r.key);
    }
    return [];
  }

  getStats(): Record<string, number> {
    const stats: Record<string, number> = {};

    // Initialize all known tables to 0
    for (const [table] of this.storeKinds) {
      stats[table] = 0;
    }

    const singleRows = this.stmtSingleCountByTable.all() as {
      tbl: string;
      cnt: number;
    }[];
    for (const row of singleRows) {
      stats[row.tbl] = row.cnt;
    }

    const arrayRows = this.stmtArrayCountByTable.all() as {
      tbl: string;
      cnt: number;
    }[];
    for (const row of arrayRows) {
      stats[row.tbl] = row.cnt;
    }

    return stats;
  }

  clear(): void {
    this.db.exec("DELETE FROM single_store");
    this.db.exec("DELETE FROM array_store");
    this.stmtMetaDeleteByPrefix.run("offset:");
  }

  getDiskStats(): { fileSizeBytes: number; pageCount: number; pageSize: number } {
    const pageCount = (this.db.pragma("page_count", { simple: true }) as number) ?? 0;
    const pageSize = (this.db.pragma("page_size", { simple: true }) as number) ?? 4096;

    let fileSizeBytes = pageCount * pageSize;
    try {
      const dbPath = this.db.name;
      if (dbPath && dbPath !== ":memory:") {
        fileSizeBytes = statSync(dbPath).size;
      }
    } catch {
      // Fall back to page-based estimate
    }

    return { fileSizeBytes, pageCount, pageSize };
  }

  // --- Offset methods (replaces OffsetTracker + snapshot offsets) ---

  setOffset(key: string, offset: string): void {
    this.stmtMetaUpsert.run(`offset:${key}`, offset);
  }

  getAllOffsets(): Map<string, string> {
    const rows = this.db
      .prepare("SELECT key, value FROM meta WHERE key LIKE 'offset:%'")
      .all() as { key: string; value: string }[];
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.key.slice("offset:".length), row.value);
    }
    return map;
  }

  clearOffsets(): void {
    this.stmtMetaDeleteByPrefix.run("offset:");
  }

  // --- Registry hash (replaces snapshot hash validation) ---

  getRegistryHash(): string | null {
    const row = this.stmtMetaGet.get("registry_hash") as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setRegistryHash(hash: string): void {
    this.stmtMetaUpsert.run("registry_hash", hash);
  }

  // --- Lifecycle ---

  close(): void {
    this.db.close();
  }

  // --- Private helpers ---

  private updateArrayStore(
    table: string,
    op: string,
    before: StoreRecord | null,
    after: StoreRecord | null,
    keyField: string
  ): void {
    if (op === "c" || op === "r") {
      if (!after) return;
      const key = String(after[keyField] ?? "").trim();
      if (!key) return;

      // Check for duplicates
      const existing = this.stmtArrayGetByKey.all(table, key) as {
        id: number;
        data: string;
      }[];
      const duplicate = existing.some((row) =>
        this.recordsMatch(JSON.parse(row.data), after)
      );
      if (!duplicate) {
        this.stmtArrayInsert.run(table, key, JSON.stringify(after));
      }
      return;
    }

    if (op === "u") {
      if (!before || !after) return;
      const key = String(before[keyField] ?? "").trim();
      if (!key) return;

      const existing = this.stmtArrayGetByKey.all(table, key) as {
        id: number;
        data: string;
      }[];
      const match = existing.find((row) =>
        this.recordsMatch(JSON.parse(row.data), before)
      );
      if (match) {
        this.stmtArrayUpdateById.run(JSON.stringify(after), match.id);
      } else {
        this.stmtArrayInsert.run(table, key, JSON.stringify(after));
      }
      return;
    }

    if (op === "d") {
      if (!before) return;
      const key = String(before[keyField] ?? "").trim();
      if (!key) return;

      const existing = this.stmtArrayGetByKey.all(table, key) as {
        id: number;
        data: string;
      }[];
      const match = existing.find((row) =>
        this.recordsMatch(JSON.parse(row.data), before)
      );
      if (match) {
        this.stmtArrayDeleteById.run(match.id);
      }
    }
  }

  private recordsMatch(stored: StoreRecord, before: StoreRecord): boolean {
    for (const key of Object.keys(before)) {
      const a = this.normalizeValue(stored[key]);
      const b = this.normalizeValue(before[key]);
      if (a !== b) return false;
    }
    return true;
  }

  private normalizeValue(val: unknown): unknown {
    if (typeof val === "string") return val.trim();
    return val;
  }
}

function pickFields(
  record: StoreRecord | null,
  fields: Set<string> | undefined
): StoreRecord | null {
  if (!record || !fields) return record;
  const out: StoreRecord = {};
  for (const key of fields) {
    if (key in record) out[key] = record[key];
  }
  return out;
}
