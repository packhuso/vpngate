// VPN Hub — internal worker (design §7.3 billing + §7.1 drift detection).
import { Worker, type Processor } from "bullmq";
import IORedis from "ioredis";
import {
  reconcileAllGateways,
  runBillingTick,
  pruneConnectionEvents,
  sampleAllGateways,
  pruneTrafficSamples,
} from "@vpnhub/provisioning";

const QUEUE = "internal";
const CONN_PRUNE_EVERY_MS = 24 * 60 * 60 * 1000; // daily
const CONN_RETENTION_DAYS = Number(process.env.CONN_RETENTION_DAYS ?? 90);
const DRIFT_EVERY_MS = Number(process.env.DRIFT_INTERVAL_MS ?? 10 * 60 * 1000);
const DRIFT_STARTUP_DELAY_MS = 5_000; // give the rest of the stack a moment
const BILLING_EVERY_MS = Number(
  process.env.BILLING_INTERVAL_MS ?? 60 * 60 * 1000,
); // hourly tick by default
const BILLING_STARTUP_DELAY_MS = 30_000;
const TRAFFIC_SAMPLE_MS = Number(process.env.TRAFFIC_SAMPLE_MS ?? 5 * 60 * 1000);
const TRAFFIC_STARTUP_DELAY_MS = 15_000;
const TRAFFIC_RETENTION_DAYS = Number(process.env.TRAFFIC_RETENTION_DAYS ?? 90);

const processor: Processor = async (job) => {
  switch (job.name) {
    case "billing-scheduler":
      return { ok: true, report: await runBillingTick() };
    case "send-email":
    case "abuse-detection":
      return { ok: true, job: job.name, todo: "implement in Phase 3" };
    case "drift-detection":
      return { ok: true, reports: await reconcileAllGateways() };
    default:
      throw new Error(`unknown internal job: ${job.name}`);
  }
};

let billingRunning = false;
async function runBilling(reason: string) {
  if (billingRunning) {
    console.log(`[billing] skipped (${reason}) — previous tick still running`);
    return;
  }
  billingRunning = true;
  const t0 = Date.now();
  try {
    const r = await runBillingTick();
    const summary =
      `t=${r.tunnels.charged}/${r.tunnels.suspended}/${r.tunnels.cancelled} ` +
      `i=${r.ips.charged}/${r.ips.suspended}/${r.ips.cancelled} ` +
      `b=${r.blocks.charged}/${r.blocks.suspended}/${r.blocks.cancelled} ` +
      `(charged/suspended/cancelled)`;
    console.log(`[billing] ${reason}: ${summary} (${Date.now() - t0}ms)`);
    if (r.errors.length) {
      console.error("[billing] errors:", JSON.stringify(r.errors));
    }
  } catch (e) {
    console.error("[billing] FAILED:", (e as Error).message);
  } finally {
    billingRunning = false;
  }
}

let trafficRunning = false;
async function runTrafficSample(reason: string) {
  if (trafficRunning) {
    console.log(`[traffic] skipped (${reason}) — previous run still in progress`);
    return;
  }
  trafficRunning = true;
  const t0 = Date.now();
  try {
    const r = await sampleAllGateways();
    console.log(
      `[traffic] ${reason}: gateways=${r.gatewaysOk}/${r.gatewaysOk + r.gatewaysFailed} ` +
        `tunnels=${r.tunnels} inserted=${r.inserted} (${Date.now() - t0}ms)`,
    );
    if (r.errors.length) console.error("[traffic] errors:", r.errors.join(" | "));
    // Retention prune once daily at 03:00 UTC (matches conn-prune convention).
    const nowU = new Date();
    if (nowU.getUTCHours() === 3 && nowU.getUTCMinutes() < 5) {
      const n = await pruneTrafficSamples(TRAFFIC_RETENTION_DAYS);
      if (n > 0) console.log(`[traffic-prune] removed ${n} samples older than ${TRAFFIC_RETENTION_DAYS}d`);
    }
  } catch (e) {
    console.error("[traffic] FAILED:", (e as Error).message);
  } finally {
    trafficRunning = false;
  }
}

let driftRunning = false;
async function runDrift(reason: string) {
  if (driftRunning) {
    console.log(`[drift] skipped (${reason}) — previous run still in progress`);
    return;
  }
  driftRunning = true;
  const t0 = Date.now();
  try {
    const reports = await reconcileAllGateways();
    const totalPushed = reports.reduce((n, r) => n + r.pushed.length, 0);
    const totalOrphans = reports.reduce(
      (n, r) => n + r.deletedOrphans.length,
      0,
    );
    const totalOk = reports.reduce((n, r) => n + r.alreadyOk, 0);
    const totalErr = reports.reduce((n, r) => n + r.errors.length, 0);
    console.log(
      `[drift] ${reason}: gateways=${reports.length} ok=${totalOk} ` +
        `pushed=${totalPushed} orphans=${totalOrphans} errors=${totalErr} ` +
        `(${Date.now() - t0}ms)`,
    );
    if (totalPushed || totalOrphans || totalErr) {
      console.log("[drift] detail:", JSON.stringify(reports));
    }
  } catch (e) {
    console.error("[drift] FAILED:", (e as Error).message);
  } finally {
    driftRunning = false;
  }
}

async function main() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required");
  const connection = new IORedis(url, { maxRetriesPerRequest: null });

  const worker = new Worker(QUEUE, processor, { connection, concurrency: 2 });
  worker.on("ready", () =>
    console.log(`[worker-internal] listening on "${QUEUE}"`),
  );
  worker.on("failed", (job, err) =>
    console.error(`[worker-internal] job ${job?.id} failed:`, err.message),
  );

  // Drift scheduler — startup catch-up + periodic.
  setTimeout(() => void runDrift("startup"), DRIFT_STARTUP_DELAY_MS);
  const driftTimer = setInterval(
    () => void runDrift("interval"),
    DRIFT_EVERY_MS,
  );
  console.log(
    `[drift] scheduled every ${(DRIFT_EVERY_MS / 1000) | 0}s ` +
      `(startup +${(DRIFT_STARTUP_DELAY_MS / 1000) | 0}s)`,
  );

  // Billing scheduler — startup catch-up + periodic.
  setTimeout(() => void runBilling("startup"), BILLING_STARTUP_DELAY_MS);
  const billingTimer = setInterval(
    () => void runBilling("interval"),
    BILLING_EVERY_MS,
  );
  console.log(
    `[billing] scheduled every ${(BILLING_EVERY_MS / 1000) | 0}s ` +
      `(startup +${(BILLING_STARTUP_DELAY_MS / 1000) | 0}s)`,
  );

  // Traffic sampler — every 5 min, populates bandwidth_usage for portal graph.
  setTimeout(() => void runTrafficSample("startup"), TRAFFIC_STARTUP_DELAY_MS);
  const trafficTimer = setInterval(
    () => void runTrafficSample("interval"),
    TRAFFIC_SAMPLE_MS,
  );
  console.log(
    `[traffic] scheduled every ${(TRAFFIC_SAMPLE_MS / 1000) | 0}s ` +
      `(startup +${(TRAFFIC_STARTUP_DELAY_MS / 1000) | 0}s, retention ${TRAFFIC_RETENTION_DAYS}d)`,
  );

  // Connection-events retention prune — daily.
  const pruneConn = async () => {
    try {
      const n = await pruneConnectionEvents(CONN_RETENTION_DAYS);
      if (n > 0) console.log(`[conn-prune] removed ${n} events older than ${CONN_RETENTION_DAYS}d`);
    } catch (e) {
      console.error("[conn-prune] FAILED:", (e as Error).message);
    }
  };
  setTimeout(() => void pruneConn(), 60_000);
  const connPruneTimer = setInterval(() => void pruneConn(), CONN_PRUNE_EVERY_MS);
  console.log(`[conn-prune] scheduled daily (retention ${CONN_RETENTION_DAYS}d)`);

  const shutdown = async () => {
    clearInterval(driftTimer);
    clearInterval(billingTimer);
    clearInterval(trafficTimer);
    clearInterval(connPruneTimer);
    await worker.close();
    connection.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
