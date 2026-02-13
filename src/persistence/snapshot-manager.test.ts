import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveSnapshot,
  loadSnapshot,
  deleteSnapshot,
} from "./snapshot-manager";
import { SerializedStore } from "../domain/store";

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const testDir = join(tmpdir(), `snapshot-test-${Date.now()}`);
const testPath = join(testDir, "snapshot.json");

const sampleStore: SerializedStore = {
  single: {
    ctercero: { P001: { codigo: "P001", nombre: "Acme" } },
  },
  array: {
    cterdire: { P001: [{ codigo: "P001", direcc: "Calle 1" }] },
  },
};

const sampleOffsets = new Map([
  ["topic-a-0", "100"],
  ["topic-b-0", "200"],
]);

const sampleHash = "abc123";

describe("SnapshotManager", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("saveSnapshot", () => {
    it("writes snapshot file with correct structure", () => {
      saveSnapshot(testPath, sampleHash, sampleOffsets, sampleStore);

      expect(existsSync(testPath)).toBe(true);
      const raw = JSON.parse(
        require("node:fs").readFileSync(testPath, "utf-8")
      );
      expect(raw.version).toBe(1);
      expect(raw.registryHash).toBe(sampleHash);
      expect(raw.timestamp).toBeDefined();
      expect(raw.offsets).toEqual({ "topic-a-0": "100", "topic-b-0": "200" });
      expect(raw.store.single.ctercero.P001.nombre).toBe("Acme");
    });

    it("creates parent directory if it does not exist", () => {
      const deepPath = join(testDir, "nested", "dir", "snapshot.json");
      saveSnapshot(deepPath, sampleHash, sampleOffsets, sampleStore);
      expect(existsSync(deepPath)).toBe(true);
    });
  });

  describe("loadSnapshot", () => {
    it("returns null when file does not exist", () => {
      const result = loadSnapshot(join(testDir, "nope.json"), sampleHash);
      expect(result).toBeNull();
    });

    it("loads valid snapshot and returns data", () => {
      saveSnapshot(testPath, sampleHash, sampleOffsets, sampleStore);

      const result = loadSnapshot(testPath, sampleHash);
      expect(result).not.toBeNull();
      expect(result!.offsets.get("topic-a-0")).toBe("100");
      expect(result!.store.single.ctercero.P001.nombre).toBe("Acme");
    });

    it("returns null and deletes file on registry hash mismatch", () => {
      saveSnapshot(testPath, sampleHash, sampleOffsets, sampleStore);

      const result = loadSnapshot(testPath, "different-hash");
      expect(result).toBeNull();
      expect(existsSync(testPath)).toBe(false);
    });

    it("returns null and deletes file on version mismatch", () => {
      writeFileSync(
        testPath,
        JSON.stringify({
          version: 999,
          registryHash: sampleHash,
          timestamp: new Date().toISOString(),
          offsets: {},
          store: { single: {}, array: {} },
        })
      );

      const result = loadSnapshot(testPath, sampleHash);
      expect(result).toBeNull();
      expect(existsSync(testPath)).toBe(false);
    });

    it("returns null and deletes file on corrupt JSON", () => {
      writeFileSync(testPath, "not valid json {{{");

      const result = loadSnapshot(testPath, sampleHash);
      expect(result).toBeNull();
      expect(existsSync(testPath)).toBe(false);
    });
  });

  describe("deleteSnapshot", () => {
    it("deletes existing file", () => {
      saveSnapshot(testPath, sampleHash, sampleOffsets, sampleStore);
      expect(existsSync(testPath)).toBe(true);

      deleteSnapshot(testPath);
      expect(existsSync(testPath)).toBe(false);
    });

    it("does nothing if file does not exist", () => {
      deleteSnapshot(join(testDir, "nope.json"));
      // Should not throw
    });
  });
});
