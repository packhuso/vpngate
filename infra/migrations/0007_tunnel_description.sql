-- Migration 0007 (2026-05-21): add a free-text description to tunnels.
-- The `name` is now constrained to ASCII (it's used as a config-file name, so
-- Thai/emoji produced ugly "_____" filenames). `description` is the place for a
-- human-friendly label in any language — display only, never used in filenames.
ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS description TEXT;
