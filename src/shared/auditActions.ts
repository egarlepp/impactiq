// Canonical list of audit actions — single source of truth shared between
// the server (services/audit/log.ts, which types every logAudit() call
// against it) and the client (components/admin/AuditLog.tsx's Action filter
// dropdown). Before this file existed, the two were hand-maintained
// separately and drifted badly: by v1.301 the server had 47 distinct
// AuditAction values in active use and the client's filter dropdown only
// listed 17 of them, so an admin filtering the Audit Log couldn't even
// select the majority of what the app actually logs. Add a new action here
// ONCE and both sides pick it up — there is no second list to remember to
// update.
export const AUDIT_ACTIONS = [
  'user.create',
  'user.update',
  'user.delete',
  'user.reset_password',
  'user.mfa_regenerate_backup_codes',
  // vNext: User Management's per-row Verify button (Salesforce/Outlook
  // connection icons) — an admin-triggered live probe of ANOTHER user's
  // stored OAuth token. Read-only (no data is written to either provider),
  // but it does decrypt and use someone else's credential, so it gets the
  // same audit trail as any other action that touches another user's
  // integration state. Never fires automatically — only on an explicit click.
  'user.verify_connection',
  // v1.425.0 (security audit L8): disabling also revokes sessions and API keys.
  'user.disable',
  'user.enable',
  'team.create',
  'team.update',
  'team.delete',
  'role_permissions.update',
  // v1.441.0: Admin → Scheduling's Clear on Recent runs (deletes every job run since v1.443.0).
  'job_runs.clear',
  'integration.salesforce.save',
  'integration.microsoft.save',
  'integration.okta.save',
  'integration.azure.save',
  'integration.rate_limit.save',
  'integration.azure_sso.save',
  'integration.azure_sso.clear',
  'integration.email.save',
  'integration.slack.save',
  'integration.salesforce.clear',
  'integration.microsoft.clear',
  'integration.okta.clear',
  'integration.azure.clear',
  'integration.email.clear',
  'integration.slack.clear',
  'integration.login_logo.save',
  'integration.login_logo.clear',
  'integration.login_logo.resize',
  'integration.crm_features.update',
  // v1.446.0: Admin → Workplace → Terminology; meta says what was renamed.
  'terminology.update',
  'integration.crm_provider.update',
  'integration.evaluation_source.update',
  'integration.criteriaiq.save',
  'integration.criteriaiq.clear',
  'integration.criteriaiq.live_refresh.enable',
  'integration.criteriaiq.live_refresh.rotate',
  'integration.criteriaiq.live_refresh.disable',
  'integration.gong.save',
  'integration.gong.clear',
  'integration.gong.oauth_connect',
  'integration.gong.sync_users',
  'integration.gong.transcript_access',
  'integration.gong.user_link',
  'integration.gong.linking',
  'activity.gong_call.link',
  'activity.gong_call.unlink',
  'team.ai_notes.update',
  // v1.461.0: Admin → Activities & Rules → AI Assessments.
  'ai_assessment.create',
  'ai_assessment.update',
  'ai_assessment.delete',
  'ai_assessment.assign',
  'ai_assessment.unassign',
  // v1.466.0: AI Note profiles (AI Assessments → Settings).
  'ai_note_profile.create',
  'ai_note_profile.update',
  'ai_note_profile.delete',
  'integration.hubspot.save',
  'integration.hubspot.clear',
  'integration.hubspot.sync_owners',
  'integration.hubspot.deal_edit_policy',
  'ai.provider.create',
  'ai.provider.update',
  'ai.provider.delete',
  'ai.provider.set_default',
  'ai.provider.test',
  'ai.settings.update',
  'ai.feature_route.update',
  'event_webhook.create',
  'event_webhook.update',
  'event_webhook.delete',
  'event_webhook.rotate_secret',
  'event_webhook.test',
  'event_webhook.retry',
  'criteriaiq.evaluation_link.set',
  'criteriaiq.evaluation_link.clear',
  'integration.outlook_sync.update',
  'integration.sf_internal_domains.update',
  'integration.okta_allow_unverified.update',
  'apikey.create',
  'apikey.revoke',
  'fx_rates.refresh',
  'sf_users.sync',
  'sf_alignment.update',
  'work_week.approve',
  'work_week.reject',
  // v1.214.0: historical Salesforce Event import (pre-ImpactIQ activity).
  'historical_import.start',
  'historical_import.pause',
  'historical_import.resume',
  'historical_import.reset',
  'historical_import.relink',
  // v1.215.0: exclusion rules for machine-generated Salesforce Events.
  'historical_import.exclusion_add',
  'historical_import.exclusion_update',
  'historical_import.exclusion_remove',
  'historical_import.exclusion_purge',
  'historical_import.settings_update',
  // v1.242.0: the one HARD delete in the product. An approved activity whose
  // Outlook event was deleted, that the user then chose to delete everywhere —
  // row gone from Postgres and the Event/Task deleted in Salesforce. Nothing
  // else can reconstruct it, so the audit row is the only remaining record
  // that it ever existed. Meta carries the identifying fields for that reason.
  'activity.outlook_deleted.purge',
  'activity.outlook_deleted.keep',
  // v1.254.0: a dated note prepended to a Salesforce text field (Engineer
  // Notes / Situation-Next Steps on the linked Evaluation record) — an
  // append, not the usual overwrite-on-save write.
  'salesforce.field_prepend',
  // v1.289.0: security audit finding E1 — SF Field Mapping changes were
  // completely unaudited despite being exactly the kind of change that can
  // silently misdirect or blank a Salesforce write with no sync-time error
  // (CLAUDE.md §9's Validate & dry run panel exists precisely because bad
  // mappings fail silently). meta carries a before/after diff on update.
  'sf_field_mapping.create',
  'sf_field_mapping.update',
  'sf_field_mapping.delete',
  // v1.374.0: Admin → Activity Types → Import. One row per apply, meta is a
  // flat summary (created/updated counts + source file info).
  'activity_type.import',
  // v1.332.0: App Update settings (Admin → Integrations → App Updates) —
  // configuring/clearing the GitHub PAT + repo/branch is a default-admin-only
  // action (rbac.ts's requireDefaultAdmin), audited the same way every other
  // integration credential save/clear already is.
  'system_update.settings_save',
  'system_update.settings_clear',
  'system_update.check_now',
  // v1.333.0: App Updates Phase 2 — a default-admin-scheduled maintenance
  // window (announced to every user, see MaintenanceBanner.tsx) that ends in
  // the app restarting its own process. Schedule/cancel are ordinary
  // default-admin actions, audited like any other config change.
  // restart_triggered is different — it's written by the restart-scheduler
  // background job itself, not a request handler, so it goes through
  // logSystemAudit() (services/audit/log.ts) with a null actor rather than
  // logAudit(req, ...); the Audit Log still shows it, just with no actor.
  'system_update.maintenance_schedule',
  'system_update.maintenance_cancel',
  'system_update.restart_triggered',
  // vNext: Opportunity Relink (CLAUDE.md §7) — bulk-moves every ImpactIQ
  // activity linked to an Opportunity closed Lost/Duplicate onto a
  // replacement Opportunity, plus re-queues the matching Salesforce
  // Event/Task records for write-back. A data CORRECTION, not destructive —
  // same classification as sf_field_mapping.update, not sf_field_mapping.delete.
  'activity.relink_opportunity',
  // HubSpot plan, phase 7: the nightly link-health job (or the drawer's live
  // check) moved activities off a HubSpot record that was merged into another.
  // A correction, not destructive; logged with no actor.
  'activity.crm_merge_relink',
  // vNext: Announcements (Admin → Workplace, CLAUDE.md §14) — an admin/
  // team_admin/leader broadcast targeted at a team, subteam, or specific
  // user. create/update are not destructive; delete is (removes it for
  // every viewer immediately, added to DESTRUCTIVE_AUDIT_ACTIONS below).
  'announcement.create',
  'announcement.update',
  'announcement.delete',
  // Admin → Monitoring & Audit → Backup & Restore (CLAUDE.md §14d). export
  // downloads a full copy of the database (password hashes, encrypted
  // tokens and all), so it's audited even though it changes nothing.
  // restore replaces every table — written inside the restore transaction
  // itself so it lands in the restored audit log; restore_failed is
  // written outside it when a restore is refused or rolled back.
  'system_backup.export',
  'system_backup.restore',
  'system_backup.restore_failed',
  // v1.444.0: how long App Health waits before reminding about a backup.
  'system_backup.reminder',
  // v1.434.0: Admin → Demo Data. Generate can create a password sign-in for
  // a demo Team Leader, so who generated (and removed) demo data is kept.
  'demo_data.generate',
  'demo_data.reseed',
  'demo_data.remove',
  'job_runs.clear',
] as const

export type AuditAction = typeof AUDIT_ACTIONS[number]

// v1.330.0: curated subset of AUDIT_ACTIONS that destroy or revoke something —
// backs the Audit Log KPI row's "Destructive Actions" card. Deliberately a
// hand-picked list, not a suffix heuristic on the action string (e.g. "ends
// with .delete/.purge/.reset") — that would misclassify
// 'activity.outlook_deleted.keep' (contains "deleted" but is the KEEP branch,
// the opposite of destructive) and 'work_week.reject' (a workflow decision,
// not data loss). Add a new action here only when it genuinely destroys data
// or revokes access — same "single source of truth, add once" contract as
// AUDIT_ACTIONS itself.
export const DESTRUCTIVE_AUDIT_ACTIONS: readonly AuditAction[] = [
  'ai_assessment.delete',
  'ai_note_profile.delete',
  'user.delete',
  'user.disable',
  'team.delete',
  'apikey.revoke',
  'integration.salesforce.clear',
  'integration.microsoft.clear',
  'integration.okta.clear',
  'integration.azure.clear',
  'integration.email.clear',
  'integration.slack.clear',
  'integration.hubspot.clear',
  'integration.gong.clear',
  'integration.azure_sso.clear',
  'ai.provider.delete',
  'event_webhook.delete',
  'historical_import.exclusion_remove',
  'historical_import.exclusion_purge',
  'activity.outlook_deleted.purge',
  'sf_field_mapping.delete',
  'announcement.delete',
  'system_backup.restore',
  'demo_data.remove',
  'demo_data.reseed',
  'job_runs.clear',
]
