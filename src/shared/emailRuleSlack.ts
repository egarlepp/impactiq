// v1.436.0: Communications rules that can also go out as a Slack DM
// (Admin → Communications → "Also send as Slack DM"). The DM goes to the
// same person the email goes to: the user for the digest, recap and
// sign-in alert, App Admins only for the job failure and AI budget alerts.
// Left out on purpose: nudge_email (nudge rules have their own Slack DM
// switch), welcome / invitation / password_reset (a new or locked-out
// person usually isn't linked to Slack, and a reset link shouldn't sit in
// Slack), and the two test emails.
export const SLACK_DM_EMAIL_RULES = [
  'daily_digest',
  'weekly_recap',
  'login_new_location',
  'job_failure_alert',
  'ai_budget_reached',
] as const

export type SlackDmEmailRuleKey = (typeof SLACK_DM_EMAIL_RULES)[number]

export const ADMIN_ONLY_EMAIL_RULES: readonly string[] = ['job_failure_alert', 'ai_budget_reached']

export function emailRuleSupportsSlackDm(key: string): key is SlackDmEmailRuleKey {
  return (SLACK_DM_EMAIL_RULES as readonly string[]).includes(key)
}
