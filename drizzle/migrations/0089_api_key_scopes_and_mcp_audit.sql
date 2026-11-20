-- v1.145.0: MCP server groundwork.
-- 1. Scope API keys. Existing keys default to rest:full so nothing breaks.
ALTER TABLE "api_keys" ADD COLUMN "scopes" text[] DEFAULT ARRAY['rest:full']::text[] NOT NULL;--> statement-breakpoint

-- 2. Every MCP tool invocation writes a row here. Retained 30 days
--    (same as sync-audit + nudge-history), culled by the existing worker.
--    args_hash is a SHA-256 hex of the JSON args — never the args themselves,
--    so no PII leaks into this table.
CREATE TABLE IF NOT EXISTS "mcp_tool_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "api_key_id" uuid REFERENCES "api_keys"("id") ON DELETE SET NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "tool" text NOT NULL,
  "args_hash" text,
  "status" text NOT NULL,
  "latency_ms" integer,
  "error" text,
  "called_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mcp_tool_calls_called_at_idx" ON "mcp_tool_calls" ("called_at" DESC);
