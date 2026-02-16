import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStore } from "./sqlite-store";
import { TableDefinition, computeRegistryHash } from "./table-registry";

const miniRegistry: TableDefinition[] = [
  {
    table: "ctercero",
    storeKind: "single",
    watchedFields: [],
    topic: "t.ctercero",
  },
  {
    table: "gproveed",
    storeKind: "single",
    watchedFields: [],
    topic: "t.gproveed",
  },
  {
    table: "cterdire",
    storeKind: "array",
    watchedFields: [],
    topic: "t.cterdire",
  },
];

const customKeyRegistry: TableDefinition[] = [
  {
    table: "cterasoc",
    storeKind: "array",
    watchedFields: [],
    topic: "t.cterasoc",
    storeFields: ["seqno", "tipaso", "tercer"],
    keyField: "tercer",
  },
];

const filteredRegistry: TableDefinition[] = [
  {
    table: "ctercero",
    storeKind: "single",
    watchedFields: [],
    topic: "t.ctercero",
    storeFields: ["codigo", "nombre"],
  },
  {
    table: "cterdire",
    storeKind: "array",
    watchedFields: [],
    topic: "t.cterdire",
    storeFields: ["codigo", "direcc"],
  },
];

describe("SqliteStore", () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(":memory:", miniRegistry);
  });

  afterEach(() => {
    store.close();
  });

  describe("single store CRUD", () => {
    it("sets via create and retrieves", () => {
      store.update("ctercero", "c", null, { codigo: "P001", nombre: "Acme" });

      expect(store.getSingle("ctercero", "P001")).toEqual({
        codigo: "P001",
        nombre: "Acme",
      });
    });

    it("sets via update", () => {
      store.update(
        "ctercero",
        "u",
        { codigo: "P001", nombre: "Old" },
        { codigo: "P001", nombre: "New" }
      );

      expect(store.getSingle("ctercero", "P001")?.["nombre"]).toBe("New");
    });

    it("deletes via op=d", () => {
      store.update("ctercero", "c", null, { codigo: "P001", nombre: "Acme" });
      store.update("ctercero", "d", { codigo: "P001" }, null);

      expect(store.getSingle("ctercero", "P001")).toBeUndefined();
    });

    it("trims codigo whitespace", () => {
      store.update("ctercero", "c", null, {
        codigo: "  P001  ",
        nombre: "Acme",
      });

      expect(store.getSingle("ctercero", "P001")).toBeDefined();
    });

    it("handles read (snapshot) op like create", () => {
      store.update("ctercero", "r", null, { codigo: "P001", nombre: "Snap" });

      expect(store.getSingle("ctercero", "P001")?.["nombre"]).toBe("Snap");
    });
  });

  describe("single store edge cases", () => {
    it("skips null/empty codigo on create", () => {
      store.update("ctercero", "c", null, { codigo: "", nombre: "Acme" });
      store.update("ctercero", "c", null, { codigo: null, nombre: "Acme" });

      expect(store.getAllCodigos("ctercero")).toEqual([]);
    });

    it("overwrites existing record", () => {
      store.update("ctercero", "c", null, { codigo: "P001", nombre: "V1" });
      store.update("ctercero", "c", null, { codigo: "P001", nombre: "V2" });

      expect(store.getSingle("ctercero", "P001")?.["nombre"]).toBe("V2");
    });

    it("delete non-existent codigo is harmless", () => {
      store.update("ctercero", "d", { codigo: "NOPE" }, null);

      expect(store.getSingle("ctercero", "NOPE")).toBeUndefined();
    });

    it("ignores unknown table", () => {
      store.update("unknown", "c", null, { codigo: "X", foo: 1 });
      expect(store.getSingle("unknown", "X")).toBeUndefined();
    });

    it("handles case-insensitive table name", () => {
      store.update("CTERCERO", "c", null, {
        codigo: "P001",
        nombre: "Upper",
      });

      expect(store.getSingle("ctercero", "P001")?.["nombre"]).toBe("Upper");
    });
  });

  describe("array store create", () => {
    it("inserts record into array", () => {
      store.update("cterdire", "c", null, {
        codigo: "P001",
        direcc: "Calle 1",
      });

      expect(store.getArray("cterdire", "P001")).toHaveLength(1);
      expect(store.getArray("cterdire", "P001")[0]["direcc"]).toBe("Calle 1");
    });

    it("deduplicates identical records", () => {
      const record = { codigo: "P001", direcc: "Calle 1", poblac: "Madrid" };

      store.update("cterdire", "c", null, record);
      store.update("cterdire", "c", null, record);

      expect(store.getArray("cterdire", "P001")).toHaveLength(1);
    });

    it("allows different records for same codigo", () => {
      store.update("cterdire", "c", null, {
        codigo: "P001",
        direcc: "Calle 1",
      });
      store.update("cterdire", "c", null, {
        codigo: "P001",
        direcc: "Calle 2",
      });

      expect(store.getArray("cterdire", "P001")).toHaveLength(2);
    });
  });

  describe("array store update", () => {
    it("finds matching record and replaces it", () => {
      store.update("cterdire", "c", null, {
        codigo: "P001",
        direcc: "Old Addr",
      });
      store.update(
        "cterdire",
        "u",
        { codigo: "P001", direcc: "Old Addr" },
        { codigo: "P001", direcc: "New Addr" }
      );

      const arr = store.getArray("cterdire", "P001");
      expect(arr).toHaveLength(1);
      expect(arr[0]["direcc"]).toBe("New Addr");
    });

    it("appends when no match found for before", () => {
      store.update("cterdire", "c", null, {
        codigo: "P001",
        direcc: "Existing",
      });
      store.update(
        "cterdire",
        "u",
        { codigo: "P001", direcc: "NotFound" },
        { codigo: "P001", direcc: "Appended" }
      );

      expect(store.getArray("cterdire", "P001")).toHaveLength(2);
    });
  });

  describe("array store delete", () => {
    it("removes matching record", () => {
      store.update("cterdire", "c", null, {
        codigo: "P001",
        direcc: "Calle 1",
      });
      store.update("cterdire", "c", null, {
        codigo: "P001",
        direcc: "Calle 2",
      });

      store.update("cterdire", "d", { codigo: "P001", direcc: "Calle 1" }, null);

      const arr = store.getArray("cterdire", "P001");
      expect(arr).toHaveLength(1);
      expect(arr[0]["direcc"]).toBe("Calle 2");
    });

    it("removes codigo key when last record deleted", () => {
      store.update("cterdire", "c", null, {
        codigo: "P001",
        direcc: "Only",
      });
      store.update("cterdire", "d", { codigo: "P001", direcc: "Only" }, null);

      expect(store.getArray("cterdire", "P001")).toEqual([]);
      expect(store.getAllCodigos("cterdire")).not.toContain("P001");
    });
  });

  describe("array store normalize (whitespace)", () => {
    it("matches records with trimmed whitespace", () => {
      store.update("cterdire", "c", null, {
        codigo: "P001",
        direcc: "Calle 1",
      });

      // before has extra spaces — should still match
      store.update(
        "cterdire",
        "u",
        { codigo: "P001", direcc: "Calle 1  " },
        { codigo: "P001", direcc: "Updated" }
      );

      const arr = store.getArray("cterdire", "P001");
      expect(arr).toHaveLength(1);
      expect(arr[0]["direcc"]).toBe("Updated");
    });
  });

  describe("getStats", () => {
    it("returns correct counts for single and array stores", () => {
      store.update("ctercero", "c", null, { codigo: "P001", nombre: "A" });
      store.update("ctercero", "c", null, { codigo: "P002", nombre: "B" });
      store.update("gproveed", "c", null, { codigo: "P001", fecalt: 100 });
      store.update("cterdire", "c", null, {
        codigo: "P001",
        direcc: "Addr 1",
      });
      store.update("cterdire", "c", null, {
        codigo: "P001",
        direcc: "Addr 2",
      });
      store.update("cterdire", "c", null, {
        codigo: "P002",
        direcc: "Addr 3",
      });

      const stats = store.getStats();
      expect(stats["ctercero"]).toBe(2);
      expect(stats["gproveed"]).toBe(1);
      expect(stats["cterdire"]).toBe(3);
    });
  });

  describe("getAllCodigos", () => {
    it("returns all keys for a single store", () => {
      store.update("ctercero", "c", null, { codigo: "P001" });
      store.update("ctercero", "c", null, { codigo: "P002" });

      const codigos = store.getAllCodigos("ctercero");
      expect(codigos).toContain("P001");
      expect(codigos).toContain("P002");
      expect(codigos).toHaveLength(2);
    });

    it("returns all keys for an array store", () => {
      store.update("cterdire", "c", null, { codigo: "P001", direcc: "X" });
      store.update("cterdire", "c", null, { codigo: "P002", direcc: "Y" });

      const codigos = store.getAllCodigos("cterdire");
      expect(codigos).toContain("P001");
      expect(codigos).toContain("P002");
    });

    it("returns empty array for unknown table", () => {
      expect(store.getAllCodigos("nonexistent")).toEqual([]);
    });
  });

  describe("storeFields filtering", () => {
    let filtered: SqliteStore;

    beforeEach(() => {
      filtered = new SqliteStore(":memory:", filteredRegistry);
    });

    afterEach(() => {
      filtered.close();
    });

    it("keeps only declared fields on single store create", () => {
      filtered.update("ctercero", "c", null, {
        codigo: "P001",
        nombre: "Acme",
        cif: "B1234",
        extra: "drop me",
      });

      const record = filtered.getSingle("ctercero", "P001");
      expect(record).toEqual({ codigo: "P001", nombre: "Acme" });
      expect(record).not.toHaveProperty("cif");
      expect(record).not.toHaveProperty("extra");
    });

    it("keeps only declared fields on single store update", () => {
      filtered.update("ctercero", "c", null, {
        codigo: "P001",
        nombre: "Old",
        cif: "B1",
      });
      filtered.update(
        "ctercero",
        "u",
        { codigo: "P001", nombre: "Old", cif: "B1" },
        { codigo: "P001", nombre: "New", cif: "B2" }
      );

      const record = filtered.getSingle("ctercero", "P001");
      expect(record).toEqual({ codigo: "P001", nombre: "New" });
    });

    it("keeps only declared fields on array store create", () => {
      filtered.update("cterdire", "c", null, {
        codigo: "P001",
        direcc: "Calle 1",
        poblac: "Madrid",
        extra: "drop",
      });

      const arr = filtered.getArray("cterdire", "P001");
      expect(arr).toHaveLength(1);
      expect(arr[0]).toEqual({ codigo: "P001", direcc: "Calle 1" });
      expect(arr[0]).not.toHaveProperty("poblac");
    });

    it("filters before record for array store matching", () => {
      filtered.update("cterdire", "c", null, {
        codigo: "P001",
        direcc: "Calle 1",
        poblac: "Madrid",
      });
      filtered.update(
        "cterdire",
        "u",
        { codigo: "P001", direcc: "Calle 1", poblac: "Madrid" },
        { codigo: "P001", direcc: "Calle 2", poblac: "Barcelona" }
      );

      const arr = filtered.getArray("cterdire", "P001");
      expect(arr).toHaveLength(1);
      expect(arr[0]).toEqual({ codigo: "P001", direcc: "Calle 2" });
    });

    it("does not filter when storeFields is omitted", () => {
      // miniRegistry has no storeFields → all fields kept
      store.update("ctercero", "c", null, {
        codigo: "P001",
        nombre: "Acme",
        extra: "kept",
      });

      const record = store.getSingle("ctercero", "P001");
      expect(record).toHaveProperty("extra", "kept");
    });
  });

  describe("custom keyField", () => {
    let customStore: SqliteStore;

    beforeEach(() => {
      customStore = new SqliteStore(":memory:", customKeyRegistry);
    });

    afterEach(() => {
      customStore.close();
    });

    it("uses custom keyField for array store create", () => {
      customStore.update("cterasoc", "c", null, {
        tercer: "P001",
        seqno: 1,
        tipaso: "A",
      });

      expect(customStore.getArray("cterasoc", "P001")).toHaveLength(1);
      expect(customStore.getArray("cterasoc", "P001")[0]).toEqual({
        tercer: "P001",
        seqno: 1,
        tipaso: "A",
      });
    });

    it("uses custom keyField for array store update", () => {
      customStore.update("cterasoc", "c", null, {
        tercer: "P001",
        seqno: 1,
        tipaso: "A",
      });
      customStore.update(
        "cterasoc",
        "u",
        { tercer: "P001", seqno: 1, tipaso: "A" },
        { tercer: "P001", seqno: 1, tipaso: "B" }
      );

      const arr = customStore.getArray("cterasoc", "P001");
      expect(arr).toHaveLength(1);
      expect(arr[0]["tipaso"]).toBe("B");
    });

    it("uses custom keyField for array store delete", () => {
      customStore.update("cterasoc", "c", null, {
        tercer: "P001",
        seqno: 1,
        tipaso: "A",
      });
      customStore.update(
        "cterasoc",
        "d",
        { tercer: "P001", seqno: 1, tipaso: "A" },
        null
      );

      expect(customStore.getArray("cterasoc", "P001")).toEqual([]);
      expect(customStore.getAllCodigos("cterasoc")).not.toContain("P001");
    });

    it("defaults to 'codigo' when keyField is not set", () => {
      // miniRegistry has no keyField → uses "codigo" by default
      store.update("cterdire", "c", null, {
        codigo: "P001",
        direcc: "Calle 1",
      });

      expect(store.getArray("cterdire", "P001")).toHaveLength(1);
    });
  });

  describe("clear", () => {
    it("empties all stores", () => {
      store.update("ctercero", "c", null, { codigo: "P001" });
      store.update("gproveed", "c", null, { codigo: "P001" });
      store.update("cterdire", "c", null, { codigo: "P001", direcc: "X" });

      store.clear();

      expect(store.getAllCodigos("ctercero")).toEqual([]);
      expect(store.getAllCodigos("gproveed")).toEqual([]);
      expect(store.getAllCodigos("cterdire")).toEqual([]);
      expect(store.getStats()).toEqual({
        ctercero: 0,
        gproveed: 0,
        cterdire: 0,
      });
    });
  });

  describe("offsets", () => {
    it("stores and retrieves offsets", () => {
      store.setOffset("topic-a-0", "100");
      store.setOffset("topic-b-0", "200");

      const offsets = store.getAllOffsets();
      expect(offsets.get("topic-a-0")).toBe("100");
      expect(offsets.get("topic-b-0")).toBe("200");
      expect(offsets.size).toBe(2);
    });

    it("updates existing offset", () => {
      store.setOffset("topic-a-0", "100");
      store.setOffset("topic-a-0", "150");

      const offsets = store.getAllOffsets();
      expect(offsets.get("topic-a-0")).toBe("150");
      expect(offsets.size).toBe(1);
    });

    it("clears offsets", () => {
      store.setOffset("topic-a-0", "100");
      store.setOffset("topic-b-0", "200");

      store.clearOffsets();

      expect(store.getAllOffsets().size).toBe(0);
    });

    it("clear() also clears offsets", () => {
      store.setOffset("topic-a-0", "100");
      store.update("ctercero", "c", null, { codigo: "P001" });

      store.clear();

      expect(store.getAllOffsets().size).toBe(0);
      expect(store.getAllCodigos("ctercero")).toEqual([]);
    });
  });

  describe("registry hash", () => {
    it("stores and retrieves registry hash", () => {
      store.setRegistryHash("abc123");

      expect(store.getRegistryHash()).toBe("abc123");
    });

    it("returns null when no hash stored", () => {
      expect(store.getRegistryHash()).toBeNull();
    });

    it("updates existing hash", () => {
      store.setRegistryHash("abc123");
      store.setRegistryHash("def456");

      expect(store.getRegistryHash()).toBe("def456");
    });

    it("registry hash survives clear()", () => {
      store.setRegistryHash("abc123");
      store.clear();

      expect(store.getRegistryHash()).toBe("abc123");
    });
  });

  describe("getDiskStats", () => {
    it("returns disk statistics", () => {
      const stats = store.getDiskStats();
      expect(stats.pageCount).toBeGreaterThan(0);
      expect(stats.pageSize).toBeGreaterThan(0);
      expect(stats.fileSizeBytes).toBeGreaterThan(0);
    });
  });

  describe("close", () => {
    it("closes the database", () => {
      const s = new SqliteStore(":memory:", miniRegistry);
      s.close();

      // After close, operations should throw
      expect(() => s.getSingle("ctercero", "P001")).toThrow();
    });
  });
});

describe("computeRegistryHash", () => {
  it("returns a hex string", () => {
    const hash = computeRegistryHash(miniRegistry);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    expect(computeRegistryHash(miniRegistry)).toBe(
      computeRegistryHash(miniRegistry)
    );
  });

  it("changes when a table is added", () => {
    const extended: TableDefinition[] = [
      ...miniRegistry,
      {
        table: "extra",
        storeKind: "single",
        watchedFields: [],
        topic: "t.extra",
      },
    ];
    expect(computeRegistryHash(miniRegistry)).not.toBe(
      computeRegistryHash(extended)
    );
  });

  it("changes when storeFields change", () => {
    const a: TableDefinition[] = [
      { table: "t", storeKind: "single", watchedFields: [], topic: "t.t", storeFields: ["a"] },
    ];
    const b: TableDefinition[] = [
      { table: "t", storeKind: "single", watchedFields: [], topic: "t.t", storeFields: ["a", "b"] },
    ];
    expect(computeRegistryHash(a)).not.toBe(computeRegistryHash(b));
  });

  it("changes when keyField changes", () => {
    const a: TableDefinition[] = [
      { table: "t", storeKind: "array", watchedFields: [], topic: "t.t" },
    ];
    const b: TableDefinition[] = [
      { table: "t", storeKind: "array", watchedFields: [], topic: "t.t", keyField: "tercer" },
    ];
    expect(computeRegistryHash(a)).not.toBe(computeRegistryHash(b));
  });
});
