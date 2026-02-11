import { describe, it, expect } from "vitest";
import {
  ENTITY_REGISTRY,
  ENTITY_MAP,
  ENTITY_LABELS,
  ENTITY_ENDPOINTS,
} from "./entity-registry";

describe("EntityRegistry", () => {
  it("registry has at least one entry", () => {
    expect(ENTITY_REGISTRY.length).toBeGreaterThan(0);
  });

  it("each entry has required fields", () => {
    for (const e of ENTITY_REGISTRY) {
      expect(e.type).toBeTruthy();
      expect(e.label).toBeTruthy();
      expect(e.triggerPath).toBeTruthy();
      expect(e.apiPath).toBeTruthy();
      expect(e.swagger.sync.summary).toBeTruthy();
      expect(e.swagger.delete.summary).toBeTruthy();
    }
  });

  it("ENTITY_MAP indexes by type", () => {
    expect(ENTITY_MAP.get("supplier")?.label).toBe("Supplier");
    expect(ENTITY_MAP.get("contact")?.label).toBe("SupplierContact");
  });

  it("ENTITY_LABELS maps type to label", () => {
    expect(ENTITY_LABELS["supplier"]).toBe("Supplier");
    expect(ENTITY_LABELS["contact"]).toBe("SupplierContact");
  });

  it("ENTITY_ENDPOINTS maps type to apiPath", () => {
    expect(ENTITY_ENDPOINTS["supplier"]).toBe("/ingest-api/suppliers");
    expect(ENTITY_ENDPOINTS["contact"]).toBe("/ingest-api/suppliers-contacts");
  });

  it("no duplicate types in registry", () => {
    const types = ENTITY_REGISTRY.map((e) => e.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("no duplicate triggerPaths in registry", () => {
    const paths = ENTITY_REGISTRY.map((e) => e.triggerPath);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
