import { KafkaJS } from "@confluentinc/kafka-javascript";
import { AppConfig } from "../config";
import { logger } from "../logger";

export type MessageCallback = (params: {
  topic: string;
  partition: number;
  message: KafkaJS.EachMessagePayload["message"];
}) => Promise<void>;

export class OffsetTracker {
  private offsets = new Map<string, string>();

  update(topic: string, partition: number, offset: string): void {
    this.offsets.set(`${topic}-${partition}`, offset);
  }

  getAll(): Map<string, string> {
    return new Map(this.offsets);
  }
}

export interface KafkaConsumerHandle {
  disconnect(): Promise<void>;
  /** Seek all topic-partitions to offset 0 and clear resume state. */
  seekAllToBeginning(): void;
}

export async function createKafkaConsumer(
  config: AppConfig,
  onMessage: MessageCallback,
  offsetTracker: OffsetTracker,
  resumeOffsets?: Map<string, string>
): Promise<KafkaConsumerHandle> {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: {
      brokers: [config.kafka.brokers],
    },
  });

  const ephemeralGroupId = `${config.kafka.groupId}-${Date.now()}`;

  const consumer = kafka.consumer({
    kafkaJS: {
      groupId: ephemeralGroupId,
      fromBeginning: true,
      autoCommit: false,
    },
  });

  await consumer.connect();
  logger.info({ broker: config.kafka.brokers }, "Connected to Kafka");

  await consumer.subscribe({ topics: config.kafka.topics });

  const mode = resumeOffsets?.size ? "resume" : "full-rebuild";
  logger.info(
    { topics: config.kafka.topics, groupId: ephemeralGroupId, mode },
    `Subscribed to topics (${mode})`
  );

  const seekDone = new Set<string>();

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      // Seek logic: skip old messages when resuming from snapshot
      if (resumeOffsets?.size) {
        const key = `${topic}-${partition}`;
        const targetOffset = resumeOffsets.get(key);
        if (targetOffset && Number(message.offset) <= Number(targetOffset)) {
          // Seek once per partition to jump past old messages
          if (!seekDone.has(key)) {
            seekDone.add(key);
            const seekTo = String(Number(targetOffset) + 1);
            consumer.seek({ topic, partition, offset: seekTo });
            logger.info(
              { tag: "Consumer", topic, partition, seekTo },
              "Seeking to saved offset"
            );
          }
          return;
        }
      }

      await onMessage({ topic, partition, message });
      offsetTracker.update(topic, partition, message.offset);
    },
  });

  return {
    disconnect: () => consumer.disconnect(),
    seekAllToBeginning: () => {
      resumeOffsets?.clear();
      seekDone.clear();
      for (const topic of config.kafka.topics) {
        consumer.seek({ topic, partition: 0, offset: "0" });
      }
      logger.info(
        { tag: "Consumer", topics: config.kafka.topics },
        "Seeking all topics to offset 0 for full rebuild"
      );
    },
  };
}
