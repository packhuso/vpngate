// VPN Hub — gateway worker (design Section 7.1). Consumes BullMQ jobs and
// drives the real gateway agent via @vpnhub/provisioning.
import { Worker, type Processor } from "bullmq";
import IORedis from "ioredis";
import { activateTunnel, removeTunnel } from "@vpnhub/provisioning";

const QUEUE = "gateway"; // must match apps/api queue name

const processor: Processor = async (job) => {
  switch (job.name) {
    case "provision-tunnel":
      return activateTunnel(job.data.tunnelId as string);
    case "remove-tunnel":
      return removeTunnel(job.data.tunnelId as string);
    case "update-peer-ips":
    case "regenerate-tunnel-keys":
    case "update-ptr":
      return { ok: true, job: job.name, todo: "Phase 2/3" };
    default:
      throw new Error(`unknown gateway job: ${job.name}`);
  }
};

async function main() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required");
  const connection = new IORedis(url, { maxRetriesPerRequest: null });

  const worker = new Worker(QUEUE, processor, { connection, concurrency: 4 });
  worker.on("ready", () => console.log(`[worker-gateway] listening on "${QUEUE}"`));
  worker.on("completed", (job) =>
    console.log(`[worker-gateway] ${job.name} ${job.id} done`),
  );
  worker.on("failed", (job, err) =>
    console.error(`[worker-gateway] ${job?.name} ${job?.id} failed:`, err.message),
  );

  const shutdown = async () => {
    await worker.close();
    connection.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
