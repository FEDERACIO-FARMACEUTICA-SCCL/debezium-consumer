import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./pending-buffer", () => ({
  addPending: vi.fn(),
}));

import { CdcDebouncer } from "./cdc-debouncer";
import { PayloadRegistry } from "../payloads/payload-builder";
import { PayloadDispatcher } from "./dispatcher";
import { addPending } from "./pending-buffer";
import { PayloadType } from "../types/payloads";

const mockAddPending = vi.mocked(addPending);

function createMocks() {
  const mockBuilder = {
    type: "supplier" as PayloadType,
    build: vi.fn(),
  };
  const mockContactBuilder = {
    type: "contact" as PayloadType,
    build: vi.fn(),
  };

  const registry = new PayloadRegistry();
  registry.register(mockBuilder);
  registry.register(mockContactBuilder);

  const dispatcher: PayloadDispatcher = {
    dispatch: vi.fn().mockResolvedValue(undefined),
  };

  return { mockBuilder, mockContactBuilder, registry, dispatcher };
}

describe("CdcDebouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes after window timeout", async () => {
    const { mockBuilder, registry, dispatcher } = createMocks();
    mockBuilder.build.mockReturnValue([{ CodSupplier: "P001", Supplier: "X", NIF: null, StartDate: null, Status: "ACTIVE" }]);

    const debouncer = new CdcDebouncer(registry, dispatcher, 1000, 500, 10);

    debouncer.enqueue("P001", new Set<PayloadType>(["supplier"]));

    // Not flushed yet
    expect(dispatcher.dispatch).not.toHaveBeenCalled();

    // Advance past window
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockBuilder.build).toHaveBeenCalledWith("P001");
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it("merges types for same codigo", async () => {
    const { mockBuilder, mockContactBuilder, registry, dispatcher } = createMocks();
    mockBuilder.build.mockReturnValue([{ CodSupplier: "P001", Supplier: "X", NIF: null, StartDate: null, Status: "ACTIVE" }]);
    mockContactBuilder.build.mockReturnValue([{ CodSupplier: "P001", Name: "X", NIF: null, Adress: null, City: null, Country: null, Postal_Code: null, Phone: null, E_Mail: null, Status: "ACTIVE" }]);

    const debouncer = new CdcDebouncer(registry, dispatcher, 1000, 500, 10);

    debouncer.enqueue("P001", new Set<PayloadType>(["supplier"]));
    debouncer.enqueue("P001", new Set<PayloadType>(["contact"]));

    await vi.advanceTimersByTimeAsync(1000);

    // Both builders called for P001
    expect(mockBuilder.build).toHaveBeenCalledWith("P001");
    expect(mockContactBuilder.build).toHaveBeenCalledWith("P001");
    // Two dispatches (one per type)
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it("processes multiple codigos in one flush", async () => {
    const { mockBuilder, registry, dispatcher } = createMocks();
    mockBuilder.build.mockReturnValue([{ CodSupplier: "X", Supplier: "X", NIF: null, StartDate: null, Status: "ACTIVE" }]);

    const debouncer = new CdcDebouncer(registry, dispatcher, 1000, 500, 10);

    debouncer.enqueue("P001", new Set<PayloadType>(["supplier"]));
    debouncer.enqueue("P002", new Set<PayloadType>(["supplier"]));

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockBuilder.build).toHaveBeenCalledTimes(2);
    // Items grouped into single batch dispatch
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it("flushes immediately when buffer exceeds maxBufferSize", async () => {
    const { mockBuilder, registry, dispatcher } = createMocks();
    mockBuilder.build.mockReturnValue([{ CodSupplier: "X", Supplier: "X", NIF: null, StartDate: null, Status: "ACTIVE" }]);

    const debouncer = new CdcDebouncer(registry, dispatcher, 1000, 3, 100);

    debouncer.enqueue("P001", new Set<PayloadType>(["supplier"]));
    debouncer.enqueue("P002", new Set<PayloadType>(["supplier"]));

    // Not yet at limit
    expect(dispatcher.dispatch).not.toHaveBeenCalled();

    // This triggers immediate flush (size >= 3)
    debouncer.enqueue("P003", new Set<PayloadType>(["supplier"]));

    // flush is async, drain microtasks
    await vi.advanceTimersByTimeAsync(0);

    expect(mockBuilder.build).toHaveBeenCalledTimes(3);
  });

  it("does not reset timer on subsequent enqueue", async () => {
    const { mockBuilder, registry, dispatcher } = createMocks();
    mockBuilder.build.mockReturnValue([{ CodSupplier: "X", Supplier: "X", NIF: null, StartDate: null, Status: "ACTIVE" }]);

    const debouncer = new CdcDebouncer(registry, dispatcher, 1000, 500, 10);

    debouncer.enqueue("P001", new Set<PayloadType>(["supplier"]));

    // 500ms later, another enqueue
    await vi.advanceTimersByTimeAsync(500);
    debouncer.enqueue("P002", new Set<PayloadType>(["supplier"]));

    // At 1000ms from first enqueue, should flush
    await vi.advanceTimersByTimeAsync(500);

    expect(mockBuilder.build).toHaveBeenCalledTimes(2);
    expect(dispatcher.dispatch).toHaveBeenCalled();
  });

  it("calls addPending when builder returns null", async () => {
    const { mockBuilder, registry, dispatcher } = createMocks();
    mockBuilder.build.mockReturnValue(null);

    const debouncer = new CdcDebouncer(registry, dispatcher, 1000, 500, 10);

    debouncer.enqueue("P001", new Set<PayloadType>(["supplier"]));
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockAddPending).toHaveBeenCalledWith("P001", "supplier");
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("continues dispatching other batches when one fails", async () => {
    const { mockBuilder, mockContactBuilder, registry, dispatcher } = createMocks();
    mockBuilder.build.mockReturnValue([{ CodSupplier: "P001", Supplier: "X", NIF: null, StartDate: null, Status: "ACTIVE" }]);
    mockContactBuilder.build.mockReturnValue([{ CodSupplier: "P001", Name: "X", NIF: null, Adress: null, City: null, Country: null, Postal_Code: null, Phone: null, E_Mail: null, Status: "ACTIVE" }]);

    const mockDispatch = vi.mocked(dispatcher.dispatch);
    let callCount = 0;
    mockDispatch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("Network error");
    });

    const debouncer = new CdcDebouncer(registry, dispatcher, 1000, 500, 10);

    debouncer.enqueue("P001", new Set<PayloadType>(["supplier", "contact"]));
    await vi.advanceTimersByTimeAsync(1000);

    // Both types dispatched, even though first failed
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it("dispatches in correct batch sizes", async () => {
    const { mockBuilder, registry, dispatcher } = createMocks();
    // Each build returns 1 item, we'll have 25 codigos
    mockBuilder.build.mockReturnValue([{ CodSupplier: "X", Supplier: "X", NIF: null, StartDate: null, Status: "ACTIVE" }]);

    const debouncer = new CdcDebouncer(registry, dispatcher, 1000, 500, 10);

    for (let i = 0; i < 25; i++) {
      debouncer.enqueue(`P${String(i).padStart(3, "0")}`, new Set<PayloadType>(["supplier"]));
    }

    await vi.advanceTimersByTimeAsync(1000);

    // 25 items / batch size 10 = 3 batches (10, 10, 5)
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3);
  });

  it("skips flush when already flushing (anti-overlap)", async () => {
    const { mockBuilder, registry, dispatcher } = createMocks();

    let resolveDispatch: (() => void) | undefined;
    vi.mocked(dispatcher.dispatch).mockImplementation(
      () => new Promise<void>((resolve) => { resolveDispatch = resolve; })
    );
    mockBuilder.build.mockReturnValue([{ CodSupplier: "X", Supplier: "X", NIF: null, StartDate: null, Status: "ACTIVE" }]);

    const debouncer = new CdcDebouncer(registry, dispatcher, 1000, 500, 10);

    debouncer.enqueue("P001", new Set<PayloadType>(["supplier"]));
    // Start first flush
    const flushPromise = vi.advanceTimersByTimeAsync(1000);

    // While flushing, enqueue more + try another flush
    debouncer.enqueue("P002", new Set<PayloadType>(["supplier"]));
    const flush2 = debouncer.flush(); // should be no-op because flushing=true

    // Resolve the pending dispatch
    resolveDispatch!();
    await flushPromise;
    await flush2;

    // Only 1 dispatch from the first flush
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it("returns immediately when buffer is empty", async () => {
    const { registry, dispatcher } = createMocks();
    const debouncer = new CdcDebouncer(registry, dispatcher, 1000, 500, 10);

    await debouncer.flush();

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("stop() performs final flush then resolves", async () => {
    const { mockBuilder, registry, dispatcher } = createMocks();
    mockBuilder.build.mockReturnValue([{ CodSupplier: "P001", Supplier: "X", NIF: null, StartDate: null, Status: "ACTIVE" }]);

    const debouncer = new CdcDebouncer(registry, dispatcher, 1000, 500, 10);

    debouncer.enqueue("P001", new Set<PayloadType>(["supplier"]));

    await debouncer.stop();

    expect(mockBuilder.build).toHaveBeenCalledWith("P001");
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it("stop() resolves cleanly with empty buffer", async () => {
    const { registry, dispatcher } = createMocks();
    const debouncer = new CdcDebouncer(registry, dispatcher, 1000, 500, 10);

    await debouncer.stop();

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});
