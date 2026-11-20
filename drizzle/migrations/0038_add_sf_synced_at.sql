-- Record the moment writeback flipped an activity to 'synced' so the UI can
-- show "synced 3h ago" latency instead of a bare green check. Nullable —
-- historical rows have no sync timestamp until they re-sync.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS sf_synced_at timestamptz;
