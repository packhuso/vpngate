-- 0013 — per-tunnel traffic samples for the portal's data-usage graph.
-- Stores DELTAS per bucket (bytes transferred during the interval), not
-- cumulative counters. Delta storage means a WG peer-recreate / kernel
-- counter reset just shows up as one clean-zero sample instead of a
-- negative spike we'd have to filter at query time.
--
-- Sample cadence: worker-internal ticks every 5 min → one row per (tunnel,
-- bucket) at the top of each 5-min slot. ~288 rows/tunnel/day.

CREATE TABLE IF NOT EXISTS bandwidth_usage (
  tunnel_id UUID NOT NULL REFERENCES tunnels(id),
  bucket_start TIMESTAMPTZ NOT NULL,
  rx_bytes BIGINT NOT NULL,
  tx_bytes BIGINT NOT NULL,
  PRIMARY KEY (tunnel_id, bucket_start)
);

-- The API's typical query slices by time range across all tunnels of one
-- user; the PK already covers (tunnel_id, bucket_start) but a time-only
-- index helps the retention prune (`WHERE bucket_start < now() - 90d`).
CREATE INDEX IF NOT EXISTS bandwidth_usage_ts_idx
  ON bandwidth_usage(bucket_start);

-- Scratch table remembering last observed CUMULATIVE counters per tunnel
-- so the sampler can compute the delta against the previous tick even
-- across worker restarts. One row per active tunnel.
CREATE TABLE IF NOT EXISTS tunnel_stats_last (
  tunnel_id UUID PRIMARY KEY REFERENCES tunnels(id),
  last_bytes_rx BIGINT NOT NULL,
  last_bytes_tx BIGINT NOT NULL,
  last_ts TIMESTAMPTZ NOT NULL
);
