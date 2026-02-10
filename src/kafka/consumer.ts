import { KafkaJS } from "@confluentinc/kafka-javascript";
import { AppConfig } from "../config";
import { logger } from "../logger";

export type MessageCallback = (params: {
  topic: string;
  partition: number;
  message: KafkaJS.EachMessagePayload["message"];
}) => Promise<void>;

export async function createKafkaConsumer(
  config: AppConfig,
  onMessage: MessageCallback
) {
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
  logger.info(
    { topics: config.kafka.topics, groupId: ephemeralGroupId },
    "Subscribed to topics (ephemeral group, reads from beginning)"
  );

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      await onMessage({ topic, partition, message });
    },
  });

  return consumer;
}
