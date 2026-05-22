-- Migration 0009 (2026-05-22): tunnel name unique PER USER (any protocol),
-- case-insensitive, ignoring soft-deleted tunnels. Different users may reuse the
-- same name (the index is scoped by user_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tunnels_user_name
  ON tunnels (user_id, lower(name))
  WHERE deleted_at IS NULL;
