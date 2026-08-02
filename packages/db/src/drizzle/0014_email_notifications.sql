-- Email notification queue + per-user prefs.
-- Populated by worker-internal scanning audit_logs; drained by dispatcher
-- calling Resend. See packages/provisioning/src/email/.
CREATE TABLE IF NOT EXISTS email_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  audit_log_id  UUID REFERENCES audit_logs(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('instant','digest')),
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ,
  retry_count   INT  NOT NULL DEFAULT 0,
  last_error    TEXT,
  -- snapshotted at enqueue time so digest emails have context even if the
  -- underlying resource has since changed / been deleted.
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Dispatcher scans for (sent_at IS NULL AND scheduled_for <= now()); partial
-- index keeps it tiny even after millions of sent rows accumulate.
CREATE INDEX IF NOT EXISTS email_events_pending_idx
  ON email_events (scheduled_for) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS email_events_user_idx
  ON email_events (user_id, created_at DESC);

-- One row per audit_log_id so a worker restart mid-scan can't double-enqueue.
CREATE UNIQUE INDEX IF NOT EXISTS email_events_audit_unique
  ON email_events (audit_log_id) WHERE audit_log_id IS NOT NULL;

-- Checkpoint of the last audit_log we scanned. One row.
CREATE TABLE IF NOT EXISTS email_scan_state (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_scanned  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO email_scan_state (id, last_scanned)
  VALUES (1, NOW()) ON CONFLICT (id) DO NOTHING;

-- Per-user prefs. Default: enabled, 15-min digest. Rows created lazily.
CREATE TABLE IF NOT EXISTS user_email_prefs (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  digest_interval_min INT NOT NULL DEFAULT 15 CHECK (digest_interval_min BETWEEN 5 AND 240),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
