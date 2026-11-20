-- v1.178.0: Azure AD / Entra ID SSO. Store the Azure object id (oid/sub) so
-- returning Azure users match on it. Nullable + unique; oktaId keeps a
-- synthetic 'azure:<oid>' value to satisfy its NOT NULL/unique constraint.
ALTER TABLE "users" ADD COLUMN "azure_id" text;
ALTER TABLE "users" ADD CONSTRAINT "users_azure_id_unique" UNIQUE ("azure_id");
