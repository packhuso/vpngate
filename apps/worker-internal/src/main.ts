// VPN Hub — internal worker (design §7.3 billing + §7.1 drift detection).
import { Worker, type Processor } from "bullmq";
import IORedis from "ioredis";
import { reconcileAllGateways, runBillingTick } from "@vpnhub/provisioning";

const QUEUE = "internal";
const DRIFT_EVERY_MS = Number(process.env.DRIFT_INTERVAL_MS ?? 10 * 60 * 1000);
const DRIFT_STARTUP_DELAY_MS = 5_000; // give the rest of the stack a moment
const BILLING_EVERY_MS = Number(
  process.env.BILLING_INTERVAL_MS ?? 60 * 60 * 1000,
); // hourly tick by default
const BILLING_STARTUP_DELAY_MS = 30_000;

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

  const shutdown = async () => {
    clearInterval(driftTimer);
    clearInterval(billingTimer);
    await worker.close();
    connection.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
