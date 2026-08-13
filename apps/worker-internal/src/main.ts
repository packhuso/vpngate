// VPN Hub — internal worker (design §7.3 billing + §7.1 drift detection).
import { Worker, type Processor } from "bullmq";
import IORedis from "ioredis";
import {
  reconcileAllGateways,
  runBillingTick,
  pruneConnectionEvents,
  sampleAllGateways,
  pruneTrafficSamples,
  enqueueEmailEvents,
  dispatchEmailEvents,
  monitorGreTunnels,
  refreshStaleGreEndpoints,
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
const EMAIL_ENQUEUE_MS = Number(process.env.EMAIL_ENQUEUE_MS ?? 30_000);
const EMAIL_DISPATCH_MS = Number(process.env.EMAIL_DISPATCH_MS ?? 60_000);
const EMAIL_STARTUP_DELAY_MS = 45_000;
const GRE_MONITOR_MS = Number(process.env.GRE_MONITOR_MS ?? 60_000);
const GRE_REFRESH_MS = Number(process.env.GRE_REFRESH_MS ?? 60 * 60 * 1000);
const GRE_STARTUP_DELAY_MS = 20_000;

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

let emailEnqueueRunning = false;
async function runEmailEnqueue(reason: string) {
  if (emailEnqueueRunning) {
    console.log(`[email-enqueue] skipped (${reason}) — previous run still in progress`);
    return;
  }
  emailEnqueueRunning = true;
  const t0 = Date.now();
  try {
    const r = await enqueueEmailEvents();
    if (r.enqueued || r.skipped) {
      console.log(
        `[email-enqueue] ${reason}: scanned=${r.scanned} enqueued=${r.enqueued} skipped=${r.skipped} (${Date.now() - t0}ms)`,
      );
    }
  } catch (e) {
    console.error("[email-enqueue] FAILED:", (e as Error).message);
  } finally {
    emailEnqueueRunning = false;
  }
}

let emailDispatchRunning = false;
async function runEmailDispatch(reason: string) {
  if (emailDispatchRunning) {
    console.log(`[email-dispatch] skipped (${reason}) — previous run still in progress`);
    return;
  }
  emailDispatchRunning = true;
  const t0 = Date.now();
  try {
    const r = await dispatchEmailEvents();
    if (r.processed) {
      const tag = r.dryRun ? "dry-run" : "live";
      console.log(
        `[email-dispatch:${tag}] ${reason}: processed=${r.processed} sent=${r.sent} failed=${r.failed} (${Date.now() - t0}ms)`,
      );
      if (r.errors.length) console.error("[email-dispatch] errors:", r.errors.slice(0, 5).join(" | "));
    }
  } catch (e) {
    console.error("[email-dispatch] FAILED:", (e as Error).message);
  } finally {
    emailDispatchRunning = false;
  }
}

let greMonitorRunning = false;
async function runGreMonitor(reason: string) {
  if (greMonitorRunning) {
    console.log(`[gre-monitor] skipped (${reason}) — previous run still in progress`);
    return;
  }
  greMonitorRunning = true;
  const t0 = Date.now();
  try {
    const r = await monitorGreTunnels();
    if (r.checked || r.errors.length) {
      console.log(
        `[gre-monitor] ${reason}: checked=${r.checked} reachable=${r.reachable} ` +
          `unreachable=${r.unreachable} reresolves=${r.reresolves} ipChanges=${r.ipChanges} (${Date.now() - t0}ms)`,
      );
      if (r.errors.length) console.error("[gre-monitor] errors:", r.errors.slice(0, 5).join(" | "));
    }
  } catch (e) {
    console.error("[gre-monitor] FAILED:", (e as Error).message);
  } finally {
    greMonitorRunning = false;
  }
}

let greRefreshRunning = false;
async function runGreRefresh(reason: string) {
  if (greRefreshRunning) return;
  greRefreshRunning = true;
  try {
    const r = await refreshStaleGreEndpoints(60);
    if (r.refreshed || r.errors.length) {
      console.log(`[gre-refresh] ${reason}: refreshed=${r.refreshed} changed=${r.changed}`);
      if (r.errors.length) console.error("[gre-refresh] errors:", r.errors.slice(0, 5).join(" | "));
    }
  } catch (e) {
    console.error("[gre-refresh] FAILED:", (e as Error).message);
  } finally {
    greRefreshRunning = false;
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

  // Email notifications — enqueuer scans audit_logs, dispatcher drains queue.
  // Dry-run by default (EMAIL_ENABLED != "true") so it's safe to deploy before
  // Resend is configured; queue fills, [email-dispatch:dry-run] logs what
  // would be sent, no network calls to Resend.
  setTimeout(() => void runEmailEnqueue("startup"), EMAIL_STARTUP_DELAY_MS);
  const emailEnqueueTimer = setInterval(
    () => void runEmailEnqueue("interval"),
    EMAIL_ENQUEUE_MS,
  );
  setTimeout(() => void runEmailDispatch("startup"), EMAIL_STARTUP_DELAY_MS + 5_000);
  const emailDispatchTimer = setInterval(
    () => void runEmailDispatch("interval"),
    EMAIL_DISPATCH_MS,
  );
  console.log(
    `[email] enqueue every ${(EMAIL_ENQUEUE_MS / 1000) | 0}s, ` +
      `dispatch every ${(EMAIL_DISPATCH_MS / 1000) | 0}s ` +
      `(mode=${process.env.EMAIL_ENABLED === "true" ? "live" : "dry-run"})`,
  );

  // GRE health check — pings each active GRE peer; 3 fails → DNS re-resolve.
  setTimeout(() => void runGreMonitor("startup"), GRE_STARTUP_DELAY_MS);
  const greMonitorTimer = setInterval(
    () => void runGreMonitor("interval"),
    GRE_MONITOR_MS,
  );
  // Proactive DNS refresh — catches DNS moves while the tunnel is UP.
  setTimeout(() => void runGreRefresh("startup"), GRE_STARTUP_DELAY_MS + 30_000);
  const greRefreshTimer = setInterval(
    () => void runGreRefresh("interval"),
    GRE_REFRESH_MS,
  );
  console.log(
    `[gre] monitor every ${(GRE_MONITOR_MS / 1000) | 0}s, ` +
      `refresh every ${(GRE_REFRESH_MS / 1000) | 0}s ` +
      `(startup +${(GRE_STARTUP_DELAY_MS / 1000) | 0}s)`,
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
    clearInterval(emailEnqueueTimer);
    clearInterval(emailDispatchTimer);
    clearInterval(greMonitorTimer);
    clearInterval(greRefreshTimer);
    clearInterval(connPruneTimer);
    await worker.close();
    connection.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
