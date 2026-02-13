import { logger } from "../logger";

export class SnapshotTracker {
  private topicsDone = new Set<string>();
  private allTopics: Set<string>;
  private logCounter = 0;
  private _ready = false;

  constructor(topics: string[], startReady = false) {
    this.allTopics = new Set(topics);
    if (startReady) {
      this._ready = true;
      for (const t of this.allTopics) this.topicsDone.add(t);
      logger.info(
        { tag: "StoreRebuild" },
        "Snapshot tracker starting in ready mode (resumed from snapshot)"
      );
    }
  }

  reset(): void {
    this._ready = false;
    this.topicsDone.clear();
    this.logCounter = 0;
  }

  get ready(): boolean {
    return this._ready;
  }

  /**
   * Process a CDC event during the snapshot/replay phase.
   * Returns true if the event should be processed as live CDC.
   * Returns false if the event was consumed by the snapshot phase.
   */
  processEvent(
    op: string,
    snapshotFlag: string,
    topic: string,
    getStats: () => Record<string, number>
  ): boolean {
    if (this._ready && op !== "r") return true;

    this.logCounter++;
    if (this.logCounter % 1000 === 0) {
      const stats = getStats();
      logger.info(
        { tag: "StoreRebuild", stats, eventsProcessed: this.logCounter },
        "Store rebuild progress"
      );
    }

    if (snapshotFlag === "last") {
      for (const t of this.allTopics) this.topicsDone.add(t);
      logger.info(
        { tag: "StoreRebuild", topic },
        "All topics snapshot complete (snapshot 'last' received)"
      );
    } else if (op !== "r" && !this.topicsDone.has(topic)) {
      this.topicsDone.add(topic);
      logger.info(
        {
          tag: "StoreRebuild",
          topic,
          done: this.topicsDone.size,
          total: this.allTopics.size,
        },
        "Topic snapshot complete"
      );
    }

    if (!this._ready && this.topicsDone.size >= this.allTopics.size) {
      this._ready = true;
      const stats = getStats();
      logger.info(
        { tag: "StoreRebuild", stats, eventsReplayed: this.logCounter },
        "Store rebuild complete"
      );
      this.logCounter = 0;

      // If this event is a snapshot event, don't process it as live
      if (op === "r") return false;
      // Fall through to process this live event
      return true;
    }

    return false;
  }
}
