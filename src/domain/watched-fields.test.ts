import { describe, it, expect, vi } from "vitest";

vi.mock("./table-registry", () => ({
  WATCHED_FIELDS: {
    ctercero: ["codigo", "nombre", "cif"],
    gproveed: ["fecalt", "fecbaj"],
  },
}));

import { detectChanges } from "./watched-fields";
import { DebeziumEvent, DebeziumSource } from "../types/debezium";

const BASE_SOURCE: DebeziumSource = {
  version: "1",
  connector: "informix",
  name: "informix",
  ts_ms: 0,
  snapshot: "false",
  db: "test",
  sequence: null,
  schema: "informix",
  table: "ctercero",
  change_lsn: null,
  commit_lsn: null,
};

function makeEvent(opts: {
  op: DebeziumEvent["op"];
  table: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}): DebeziumEvent {
  return {
    before: opts.before ?? null,
    after: opts.after ?? null,
    op: opts.op,
    ts_ms: Date.now(),
    transaction: null,
    source: { ...BASE_SOURCE, table: opts.table },
  };
}

describe("detectChanges", () => {
  describe("CREATE (op=c)", () => {
    it("returns all watched fields with before=null", () => {
      const result = detectChanges(
        makeEvent({
          op: "c",
          table: "ctercero",
          after: { codigo: "P001", nombre: "Acme", cif: "B12345" },
        })
      );

      expect(result).not.toBeNull();
      expect(result!.table).toBe("ctercero");
      expect(result!.op).toBe("c");
      expect(result!.changedFields).toEqual([
        { field: "codigo", before: null, after: "P001" },
        { field: "nombre", before: null, after: "Acme" },
        { field: "cif", before: null, after: "B12345" },
      ]);
    });

    it("sets after=null for missing fields", () => {
      const result = detectChanges(
        makeEvent({
          op: "c",
          table: "ctercero",
          after: { codigo: "P001" },
        })
      );

      expect(result).not.toBeNull();
      expect(result!.changedFields).toEqual([
        { field: "codigo", before: null, after: "P001" },
        { field: "nombre", before: null, after: null },
        { field: "cif", before: null, after: null },
      ]);
    });
  });

  describe("READ/snapshot (op=r)", () => {
    it("returns all watched fields like create", () => {
      const result = detectChanges(
        makeEvent({
          op: "r",
          table: "ctercero",
          after: { codigo: "P001", nombre: "Acme", cif: "X" },
        })
      );

      expect(result).not.toBeNull();
      expect(result!.op).toBe("r");
      expect(result!.changedFields).toHaveLength(3);
      expect(result!.changedFields[0]).toEqual({
        field: "codigo",
        before: null,
        after: "P001",
      });
    });
  });

  describe("UPDATE (op=u)", () => {
    it("detects changed fields", () => {
      const result = detectChanges(
        makeEvent({
          op: "u",
          table: "ctercero",
          before: { codigo: "P001", nombre: "OldName", cif: "B12345" },
          after: { codigo: "P001", nombre: "NewName", cif: "B12345" },
        })
      );

      expect(result).not.toBeNull();
      expect(result!.changedFields).toEqual([
        { field: "nombre", before: "OldName", after: "NewName" },
      ]);
    });

    it("returns null when no fields actually changed", () => {
      const result = detectChanges(
        makeEvent({
          op: "u",
          table: "ctercero",
          before: { codigo: "P001", nombre: "Same", cif: "B12345" },
          after: { codigo: "P001", nombre: "Same", cif: "B12345" },
        })
      );

      expect(result).toBeNull();
    });

    it("returns null for whitespace-only changes (normalize trims)", () => {
      const result = detectChanges(
        makeEvent({
          op: "u",
          table: "ctercero",
          before: { codigo: "P001", nombre: "test", cif: "B12345" },
          after: { codigo: "P001", nombre: "test  ", cif: "B12345" },
        })
      );

      expect(result).toBeNull();
    });

    it("detects only the changed field among many", () => {
      const result = detectChanges(
        makeEvent({
          op: "u",
          table: "gproveed",
          before: { fecalt: 19000, fecbaj: null },
          after: { fecalt: 19000, fecbaj: 19500 },
        })
      );

      expect(result).not.toBeNull();
      expect(result!.changedFields).toEqual([
        { field: "fecbaj", before: null, after: 19500 },
      ]);
    });
  });

  describe("DELETE (op=d)", () => {
    it("returns all watched fields with after=null", () => {
      const result = detectChanges(
        makeEvent({
          op: "d",
          table: "ctercero",
          before: { codigo: "P001", nombre: "Acme", cif: "B12345" },
        })
      );

      expect(result).not.toBeNull();
      expect(result!.op).toBe("d");
      expect(result!.changedFields).toEqual([
        { field: "codigo", before: "P001", after: null },
        { field: "nombre", before: "Acme", after: null },
        { field: "cif", before: "B12345", after: null },
      ]);
    });
  });

  describe("edge cases", () => {
    it("returns null for unregistered table", () => {
      const result = detectChanges(
        makeEvent({
          op: "c",
          table: "unknown_table",
          after: { id: 1 },
        })
      );

      expect(result).toBeNull();
    });

    it("handles uppercase table names (lowercased internally)", () => {
      const result = detectChanges(
        makeEvent({
          op: "c",
          table: "CTERCERO",
          after: { codigo: "P001", nombre: "Acme", cif: "X" },
        })
      );

      expect(result).not.toBeNull();
      expect(result!.table).toBe("ctercero");
    });
  });
});
