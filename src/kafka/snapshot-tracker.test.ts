import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { SnapshotTracker } from "./snapshot-tracker";

const mockGetStats = vi.fn(() => ({ ctercero: 10, gproveed: 5 }));

describe("SnapshotTracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts not ready", () => {
    const tracker = new SnapshotTracker(["topicA", "topicB", "topicC"]);
    expect(tracker.ready).toBe(false);
  });

  it("snapshot events (op=r) do not mark ready", () => {
    const tracker = new SnapshotTracker(["topicA", "topicB"]);

    const result = tracker.processEvent("r", "true", "topicA", mockGetStats);

    expect(result).toBe(false);
    expect(tracker.ready).toBe(false);
  });

  it("first non-read event marks a single topic done but not ready", () => {
    const tracker = new SnapshotTracker(["topicA", "topicB", "topicC"]);

    const result = tracker.processEvent("c", "false", "topicA", mockGetStats);

    expect(result).toBe(false);
    expect(tracker.ready).toBe(false);
  });

  it("marks ready when all topics have received a non-read event", () => {
    const tracker = new SnapshotTracker(["topicA", "topicB"]);

    tracker.processEvent("c", "false", "topicA", mockGetStats);
    expect(tracker.ready).toBe(false);

    // The event that completes the last topic should return true (it's live)
    const result = tracker.processEvent("c", "false", "topicB", mockGetStats);

    expect(tracker.ready).toBe(true);
    expect(result).toBe(true);
  });

  it("returns false for op=r even after ready", () => {
    const tracker = new SnapshotTracker(["topicA"]);

    // Complete snapshot
    tracker.processEvent("c", "false", "topicA", mockGetStats);
    expect(tracker.ready).toBe(true);

    // Snapshot event after ready
    const result = tracker.processEvent("r", "true", "topicA", mockGetStats);
    expect(result).toBe(false);
  });

  it("returns true for live events after ready", () => {
    const tracker = new SnapshotTracker(["topicA"]);

    tracker.processEvent("c", "false", "topicA", mockGetStats);
    expect(tracker.ready).toBe(true);

    const result = tracker.processEvent("u", "false", "topicA", mockGetStats);
    expect(result).toBe(true);
  });

  it("snapshot flag 'last' marks ready immediately", () => {
    const tracker = new SnapshotTracker(["topicA", "topicB", "topicC"]);

    tracker.processEvent("r", "last", "topicA", mockGetStats);

    expect(tracker.ready).toBe(true);
  });

  it("flag 'last' + op=r returns false", () => {
    const tracker = new SnapshotTracker(["topicA", "topicB"]);

    const result = tracker.processEvent("r", "last", "topicA", mockGetStats);

    expect(tracker.ready).toBe(true);
    expect(result).toBe(false);
  });

  it("flag 'last' + non-read op returns true", () => {
    const tracker = new SnapshotTracker(["topicA", "topicB"]);

    const result = tracker.processEvent("u", "last", "topicA", mockGetStats);

    expect(tracker.ready).toBe(true);
    expect(result).toBe(true);
  });

  it("empty topics list — first non-read event makes ready", () => {
    const tracker = new SnapshotTracker([]);

    expect(tracker.ready).toBe(false);

    const result = tracker.processEvent("c", "false", "topicA", mockGetStats);

    // With 0 topics, topicsDone.size(0) >= allTopics.size(0) is true even before the event
    // but _ready is checked before topicsDone is updated. Let's verify:
    expect(tracker.ready).toBe(true);
    expect(result).toBe(true);
  });

  it("duplicate non-read on same topic does not break count", () => {
    const tracker = new SnapshotTracker(["topicA", "topicB"]);

    tracker.processEvent("c", "false", "topicA", mockGetStats);
    tracker.processEvent("u", "false", "topicA", mockGetStats);
    expect(tracker.ready).toBe(false);

    const result = tracker.processEvent("c", "false", "topicB", mockGetStats);
    expect(tracker.ready).toBe(true);
    expect(result).toBe(true);
  });
});
