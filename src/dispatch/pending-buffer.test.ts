import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to reset the module state between tests since pending-buffer uses module-level state.
// We'll use dynamic imports with vi.resetModules().

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { PayloadType } from "../types/payloads";

function createMockRegistry() {
  const builder = {
    type: "supplier" as PayloadType,
    build: vi.fn(),
  };
  const contactBuilder = {
    type: "contact" as PayloadType,
    build: vi.fn(),
  };
  return {
    builder,
    contactBuilder,
    registry: {
      get: vi.fn((type: PayloadType) => {
        if (type === "supplier") return builder;
        if (type === "contact") return contactBuilder;
        return undefined;
      }),
      register: vi.fn(),
      buildAll: vi.fn(),
    },
  };
}

function createMockDispatcher() {
  return {
    dispatch: vi.fn().mockResolvedValue(undefined),
  };
}

describe("pending-buffer", () => {
  let addPending: typeof import("./pending-buffer").addPending;
  let startRetryLoop: typeof import("./pending-buffer").startRetryLoop;
  let stopRetryLoop: typeof import("./pending-buffer").stopRetryLoop;
  let getPendingStats: typeof import("./pending-buffer").getPendingStats;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const mod = await import("./pending-buffer");
    addPending = mod.addPending;
    startRetryLoop = mod.startRetryLoop;
    stopRetryLoop = mod.stopRetryLoop;
    getPendingStats = mod.getPendingStats;
  });

  afterEach(() => {
    stopRetryLoop();
    vi.useRealTimers();
  });

  it("addPending creates a new entry", () => {
    addPending("P001", "supplier");

    expect(getPendingStats().count).toBe(1);
    expect(getPendingStats().codigos).toEqual(["P001"]);
  });

  it("addPending merges types for same codigo", () => {
    addPending("P001", "supplier");
    addPending("P001", "contact");

    expect(getPendingStats().count).toBe(1);
  });

  it("retry succeeds and removes entry", async () => {
    const { registry, builder } = createMockRegistry();
    const dispatcher = createMockDispatcher();
    builder.build.mockReturnValue([{ CodSupplier: "P001" }]);

    addPending("P001", "supplier");
    startRetryLoop(registry as any, dispatcher);

    await vi.advanceTimersByTimeAsync(2000);

    expect(builder.build).toHaveBeenCalledWith("P001");
    expect(dispatcher.dispatch).toHaveBeenCalled();
    expect(getPendingStats().count).toBe(0);
  });

  it("retry keeps entry when build returns null", async () => {
    const { registry, builder } = createMockRegistry();
    const dispatcher = createMockDispatcher();
    builder.build.mockReturnValue(null);

    addPending("P001", "supplier");
    startRetryLoop(registry as any, dispatcher);

    await vi.advanceTimersByTimeAsync(2000);

    expect(getPendingStats().count).toBe(1);
  });

  it("partial retry — successful type removed, failed remains", async () => {
    const { registry, builder, contactBuilder } = createMockRegistry();
    const dispatcher = createMockDispatcher();
    builder.build.mockReturnValue([{ CodSupplier: "P001" }]);
    contactBuilder.build.mockReturnValue(null);

    addPending("P001", "supplier");
    addPending("P001", "contact");
    startRetryLoop(registry as any, dispatcher);

    await vi.advanceTimersByTimeAsync(2000);

    // supplier succeeded, contact still null → entry remains with 1 type
    expect(getPendingStats().count).toBe(1);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it("evicts entry after max retries", async () => {
    const { registry, builder } = createMockRegistry();
    const dispatcher = createMockDispatcher();
    builder.build.mockReturnValue(null);

    addPending("P001", "supplier");
    startRetryLoop(registry as any, dispatcher);

    // MAX_RETRIES=5, RETRY_INTERVAL=2000ms → 6 cycles to exceed
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    expect(getPendingStats().count).toBe(0);
  });

  it("evicts entry after max age", async () => {
    const { registry, builder } = createMockRegistry();
    const dispatcher = createMockDispatcher();
    builder.build.mockReturnValue(null);

    addPending("P001", "supplier");
    startRetryLoop(registry as any, dispatcher);

    // MAX_AGE_MS=60000 → advance past 60s
    // With 2s intervals, 31 ticks = 62s
    for (let i = 0; i < 31; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    expect(getPendingStats().count).toBe(0);
  });

  it("evicts oldest when at max capacity", () => {
    // MAX_PENDING_SIZE = 10_000 — we'll test the eviction logic
    // by filling up and adding one more
    for (let i = 0; i < 10_000; i++) {
      addPending(`C${i}`, "supplier");
    }

    expect(getPendingStats().count).toBe(10_000);

    // Adding one more should evict the oldest
    addPending("NEW", "supplier");

    expect(getPendingStats().count).toBe(10_000);
    expect(getPendingStats().codigos).toContain("NEW");
    expect(getPendingStats().codigos).not.toContain("C0");
  });

  it("dispatch error does not remove type, retries next cycle", async () => {
    const { registry, builder } = createMockRegistry();
    const dispatcher = createMockDispatcher();
    builder.build.mockReturnValue([{ CodSupplier: "P001" }]);
    dispatcher.dispatch.mockRejectedValueOnce(new Error("Network error"));

    addPending("P001", "supplier");
    startRetryLoop(registry as any, dispatcher);

    // First cycle: dispatch fails
    await vi.advanceTimersByTimeAsync(2000);
    expect(getPendingStats().count).toBe(1);

    // Second cycle: dispatch succeeds (default mock resolves)
    dispatcher.dispatch.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(2000);
    expect(getPendingStats().count).toBe(0);
  });

  it("stopRetryLoop clears the timer", async () => {
    const { registry, builder } = createMockRegistry();
    const dispatcher = createMockDispatcher();
    builder.build.mockReturnValue(null);

    addPending("P001", "supplier");
    startRetryLoop(registry as any, dispatcher);
    stopRetryLoop();

    await vi.advanceTimersByTimeAsync(10000);

    // Build was never called because timer was stopped
    expect(builder.build).not.toHaveBeenCalled();
  });

  it("anti-overlap: second interval skips when first is still running", async () => {
    const { registry, builder } = createMockRegistry();

    let resolveDispatch: (() => void) | undefined;
    const dispatcher = {
      dispatch: vi.fn(
        () => new Promise<void>((resolve) => { resolveDispatch = resolve; })
      ),
    };
    builder.build.mockReturnValue([{ CodSupplier: "P001" }]);

    addPending("P001", "supplier");
    startRetryLoop(registry as any, dispatcher);

    // First interval fires, starts retrying (slow dispatch)
    await vi.advanceTimersByTimeAsync(2000);

    // Second interval fires while first is still running
    await vi.advanceTimersByTimeAsync(2000);

    // Only 1 dispatch call (second interval was skipped)
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);

    // Resolve the pending dispatch
    resolveDispatch!();
    await vi.advanceTimersByTimeAsync(0);
  });
});
