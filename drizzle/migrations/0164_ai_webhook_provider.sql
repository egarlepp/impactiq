-- v1.426.0: the AI Assistant's Webhook provider (docs/ai-webhook.md). An App
-- Admin can let a webhook provider call a private-network address (n8n or a
-- model on the same Docker network or VNet). Loopback and cloud metadata
-- addresses stay blocked either way.
ALTER TABLE "ai_providers" ADD COLUMN IF NOT EXISTS "allow_private_network" boolean DEFAULT false NOT NULL;
