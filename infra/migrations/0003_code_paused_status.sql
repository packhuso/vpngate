-- Migration 0003 (2026-05-21): add 'paused' to code_status so admin can
-- suspend an individual code and re-activate it later (vs 'revoked' = delete).
ALTER TYPE code_status ADD VALUE IF NOT EXISTS 'paused';
