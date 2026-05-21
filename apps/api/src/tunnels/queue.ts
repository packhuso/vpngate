import { Queue } from "bullmq";
import IORedis from "ioredis";

// Shared BullMQ "gateway" queue (design Section 7.1 outbox→worker).
// Queue name must match worker-gateway.
export const GATEWAY_QUEUE = "gateway";

let queue: Queue | undefined;

export function gatewayQueue(): Queue {
  if (!queue) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required");
    const connection = new IORedis(url, { maxRetriesPerRequest: null });
    queue = new Queue(GATEWAY_QUEUE, { connection });
  }
  return queue;
}
