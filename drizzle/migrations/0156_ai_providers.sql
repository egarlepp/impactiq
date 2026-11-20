-- v1.391.0: AI Assistant (Admin → Integrations → AI Assistant, CLAUDE.md §14).
-- Several AI providers instead of the one Azure OpenAI integration, a
-- per-feature routing table, a usage log feeding the monthly budget, and a
-- cache of calendar-event classifications. The old Azure OpenAI settings row
-- is copied into ai_providers (same encrypted key, same cipher) and then
-- deleted; there is no AZURE_OPENAI_* env-var fallback any more.
CREATE TABLE "ai_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "is_default" boolean NOT NULL DEFAULT false,
  "model" text NOT NULL,
  "secret_encrypted" text,
  "endpoint" text,
  "api_version" text,
  "allowed_custom_host" text,
  "region" text,
  "access_key_id" text,
  "resource" text,
  "organization" text,
  "input_price_per_mtok" numeric(10, 4),
  "output_price_per_mtok" numeric(10, 4),
  "last_tested_at" timestamptz,
  "last_test_ok" boolean,
  "last_test_message" text,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_providers_one_default" ON "ai_providers" ("is_default") WHERE "is_default";
--> statement-breakpoint
CREATE TABLE "ai_feature_routes" (
  "feature" text PRIMARY KEY,
  "provider_id" uuid NOT NULL REFERENCES "ai_providers"("id") ON DELETE CASCADE,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ai_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "feature" text NOT NULL,
  "provider_id" uuid REFERENCES "ai_providers"("id") ON DELETE SET NULL,
  "provider_kind" text,
  "provider_name" text,
  "model" text,
  "requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "input_hash" text,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cost_usd" numeric(12, 6) NOT NULL DEFAULT '0',
  "status" text NOT NULL,
  "error" text,
  "duration_ms" integer,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "ai_requests_created_at_idx" ON "ai_requests" ("created_at");
--> statement-breakpoint
CREATE TABLE "ai_classification_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "input_hash" text NOT NULL,
  "provider_id" uuid REFERENCES "ai_providers"("id") ON DELETE CASCADE,
  "activity_type_id" uuid REFERENCES "team_activity_types"("id") ON DELETE CASCADE,
  "confidence" numeric(4, 3),
  "hit_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_classification_cache_team_hash" UNIQUE ("team_id", "input_hash")
);
--> statement-breakpoint
CREATE INDEX "ai_classification_cache_last_used_idx" ON "ai_classification_cache" ("last_used_at");
--> statement-breakpoint
INSERT INTO "ai_providers" ("kind", "name", "is_active", "is_default", "model", "secret_encrypted", "endpoint", "allowed_custom_host")
SELECT 'azure_openai', 'Azure OpenAI', true, true,
       COALESCE(NULLIF("value"->>'deployment', ''), 'gpt-4o'),
       "value"->>'apiKeyEncrypted',
       "value"->>'endpoint',
       NULLIF("value"->>'allowedCustomHost', '')
FROM "system_settings"
WHERE "key" = 'integration_config_azure_openai'
  AND COALESCE("value"->>'endpoint', '') <> ''
  AND COALESCE("value"->>'apiKeyEncrypted', '') <> '';
--> statement-breakpoint
INSERT INTO "system_settings" ("key", "value")
SELECT 'ai_settings', '{"enabled": true, "monthlyBudgetUsd": null, "budgetAlertSentFor": null}'::jsonb
WHERE EXISTS (SELECT 1 FROM "ai_providers")
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
DELETE FROM "system_settings" WHERE "key" = 'integration_config_azure_openai';
--> statement-breakpoint
INSERT INTO "email_rules" ("key", "name", "description", "is_active") VALUES
  ('ai_budget_reached', 'AI monthly budget reached', 'Sent to App Admins once per calendar month when AI requests reach the monthly budget set on Admin → Integrations → AI Assistant. AI features fall back to their non-AI behavior until next month or until the budget is raised.', true)
ON CONFLICT ("key") DO NOTHING;
