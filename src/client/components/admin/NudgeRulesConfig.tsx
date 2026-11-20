import { useTerminology } from '../../store/terminology.js'
import { evalWorkTypeName } from '../../../shared/terminology.js'
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Plus, Trash2, AlertCircle, Save, X, CheckCircle2, CircleSlash, Power, PowerOff, Eye, ChevronDown, ChevronRight, Mail, Languages, MessageSquare } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Textarea } from '../ui/textarea.js'
import { Badge } from '../ui/badge.js'
import { Spinner } from '../ui/spinner.js'
import { Select } from '../ui/select.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { TeamAssignmentPicker } from './TeamAssignmentPicker.js'
import { IconPicker } from '../ui/icon-picker.js'
import { useTeam } from '../../hooks/useTeam.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'

type TriggerType =
  | 'no_activity_days'
  | 'stage_no_type'
  | 'type_no_followup'
  | 'weekly_hours_below_target'
  | 'sf_sync_failed'
  | 'opportunity_stale'
  | 'product_gap'

interface NudgeRule {
  id: string
  teamId: string | null
  name: string
  triggerType: TriggerType
  triggerConfig: Record<string, unknown>
  messageTemplate: string
  isActive: boolean
  teamIds: string[]
  severity: 'info' | 'warning' | 'critical'
  icon: string | null
  cooldownHours: number | null
  conditions: { op: 'AND' | 'OR'; clauses: Array<{ triggerType: string; config: Record<string, unknown> }> } | null
  leaderRollupThreshold: number | null
  sendEmail: boolean
  sendSlackDm: boolean
}

interface NewRuleForm {
  name: string
  triggerType: TriggerType
  configJson: string
  messageTemplate: string
  teamIds: string[]
  severity: 'info' | 'warning' | 'critical'
  icon: string | null
  cooldownHours: number | null
  sendEmail: boolean
  sendSlackDm: boolean
}

// v1.295.0: renders the raw evidence behind a no_activity_days Preview
// result — "why is nobody shown" is otherwise an opaque number nobody can
// see anywhere else in the UI. `t` is passed in rather than called via a
// hook since this is a plain function, not a component.
function formatLastActivity(iso: string | null, t: TFunction): string {
  if (!iso) return t('admin.nudge_rules.preview_never', { defaultValue: 'never' })
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return t('admin.nudge_rules.preview_today', { defaultValue: 'today' })
  return t('admin.nudge_rules.preview_days_ago', { count: days, defaultValue: '{{count}} day ago' })
}

// evalWork: the evaluation Activity Type's name from Admin → Workplace →
// Terminology ("POx Work" by default).
const defaultConfig = (triggerType: TriggerType, evalWork: string): Record<string, unknown> => ({
  no_activity_days: { days: 5 },
  stage_no_type: { stage: 'Eval', type: evalWork, days: 14 },
  type_no_followup: { fromType: 'Discovery', toType: 'Demo', days: 21 },
  weekly_hours_below_target: { pctThreshold: 60, checkDay: 4 },
  sf_sync_failed: { count: 1 },
  opportunity_stale: { days: 21 },
  product_gap: { productId: '', days: 30 },
} satisfies Record<TriggerType, Record<string, unknown>>)[triggerType]

export function NudgeRulesConfig({ teamId }: { teamId: string }) {
  const { t } = useTranslation()
  const evalWork = evalWorkTypeName(useTerminology())
  const crmCtx = useCrmLabelContext()
  const { teams } = useTeam()
  const { user } = useCurrentUser()
  const isAppAdmin = !!user?.isAppAdmin
  const [rules, setRules] = useState<NudgeRule[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Record<string, string>>({})
  // v1.324.0: inline-editable display name, same draft-then-blur-to-save
  // pattern as messageTemplate's `editing` state below.
  const [editingName, setEditingName] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  // v1.284.0: draft text for the Trigger Config JSON input on an existing
  // rule, keyed by rule id — bound to local state (not straight to
  // rule.triggerConfig) so typing invalid JSON mid-edit doesn't snap the
  // input back to the last-committed value.
  const [configDraft, setConfigDraft] = useState<Record<string, string>>({})
  const [configInvalid, setConfigInvalid] = useState<Record<string, boolean>>({})
  const [preview, setPreview] = useState<{ ruleId: string; loading: boolean; hits: Array<{ userId: string; name: string; email: string; message: string }>; meta: { evaluated: number; total: number; sampled: boolean; dismissedCount: number; errorCount: number; activityDiagnostics?: Array<{ userId: string; name: string; lastActivityAt: string | null; recentCount?: number; dismissed?: 'permanent' | 'snoozed' | null; dismissedUntil?: string | null }>; ruleEligibleForTeam: boolean; isLeaderRollupRule?: boolean; leaderRollupThreshold?: number | null; hasConditions?: boolean; cooldownHours?: number | null } | null } | null>(null)
  // v1.96.0: collapse rules by default so the list stays scannable. The
  // first two rows render expanded on load; every other row shows a
  // header chip + expand button. Clicking any row toggles it locally.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  function isExpanded(id: string) {
    return !!expanded[id]
  }
  function toggleExpanded(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  async function openPreview(ruleId: string) {
    setPreview({ ruleId, loading: true, hits: [], meta: null })
    const res = await api.get<Array<{ userId: string; name: string; email: string; message: string }>>(`/api/admin/teams/${teamId}/nudge-rules/${ruleId}/preview`)
    const meta = (res.meta ?? {}) as { evaluated?: number; total?: number; sampled?: boolean; dismissedCount?: number; errorCount?: number; activityDiagnostics?: Array<{ userId: string; name: string; lastActivityAt: string | null; recentCount?: number; dismissed?: 'permanent' | 'snoozed' | null; dismissedUntil?: string | null }>; ruleEligibleForTeam?: boolean; isLeaderRollupRule?: boolean; leaderRollupThreshold?: number | null; hasConditions?: boolean; cooldownHours?: number | null }
    setPreview({ ruleId, loading: false, hits: res.data ?? [], meta: { evaluated: meta.evaluated ?? 0, total: meta.total ?? 0, sampled: !!meta.sampled, dismissedCount: meta.dismissedCount ?? 0, errorCount: meta.errorCount ?? 0, activityDiagnostics: meta.activityDiagnostics, ruleEligibleForTeam: meta.ruleEligibleForTeam ?? true, isLeaderRollupRule: meta.isLeaderRollupRule ?? false, leaderRollupThreshold: meta.leaderRollupThreshold ?? null, hasConditions: meta.hasConditions ?? false, cooldownHours: meta.cooldownHours ?? null } })
  }
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<NewRuleForm>({
    name: '',
    triggerType: 'no_activity_days',
    configJson: JSON.stringify(defaultConfig('no_activity_days', evalWork)),
    messageTemplate: '',
    teamIds: [teamId],
    severity: 'info',
    icon: null,
    cooldownHours: null,
    sendEmail: false,
    sendSlackDm: false,
  })
  const [error, setError] = useState<string | null>(null)

  const teamNameById = new Map(teams.map((tm) => [tm.id, tm.name]))

  async function reload() {
    setLoading(true)
    const res = await api.get<NudgeRule[]>(`/api/admin/teams/${teamId}/nudge-rules`)
    setRules(res.data ?? [])
    setLoading(false)
  }

  useEffect(() => { void reload() }, [teamId])

  async function toggleActive(id: string, isActive: boolean) {
    setSaving(id)
    await api.patch(`/api/admin/teams/${teamId}/nudge-rules/${id}`, { isActive })
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, isActive } : r)))
    setSaving(null)
  }

  async function saveName(id: string) {
    const name = editingName[id]?.trim()
    if (!name) return
    setSaving(id)
    await api.patch(`/api/admin/teams/${teamId}/nudge-rules/${id}`, { name })
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, name } : r)))
    setEditingName((prev) => { const next = { ...prev }; delete next[id]; return next })
    setSaving(null)
  }

  async function saveMessage(id: string) {
    const msg = editing[id]
    if (!msg) return
    setSaving(id)
    await api.patch(`/api/admin/teams/${teamId}/nudge-rules/${id}`, { messageTemplate: msg })
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, messageTemplate: msg } : r)))
    setEditing((prev) => { const next = { ...prev }; delete next[id]; return next })
    setSaving(null)
  }

  // v1.284.0: changing the trigger type also resets its config to that
  // type's default shape — an old rule's {stage, type, days} means nothing
  // to no_activity_days, so leaving it in place would silently misconfigure
  // the rule rather than just changing what it fires on. Mirrors the Add
  // Rule form's setTriggerType, which does the same reset on create.
  async function saveTriggerType(rule: NudgeRule, triggerType: TriggerType) {
    const triggerConfig = defaultConfig(triggerType, evalWork)
    setSaving(rule.id)
    await api.patch(`/api/admin/teams/${teamId}/nudge-rules/${rule.id}`, { triggerType, triggerConfig })
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, triggerType, triggerConfig } : r)))
    setConfigDraft((prev) => { const next = { ...prev }; delete next[rule.id]; return next })
    setConfigInvalid((prev) => { const next = { ...prev }; delete next[rule.id]; return next })
    setSaving(null)
  }

  async function saveTriggerConfig(rule: NudgeRule, raw: string) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      setConfigInvalid((prev) => ({ ...prev, [rule.id]: true }))
      return
    }
    setConfigInvalid((prev) => { const next = { ...prev }; delete next[rule.id]; return next })
    setSaving(rule.id)
    await api.patch(`/api/admin/teams/${teamId}/nudge-rules/${rule.id}`, { triggerConfig: parsed })
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, triggerConfig: parsed } : r)))
    setConfigDraft((prev) => { const next = { ...prev }; delete next[rule.id]; return next })
    setSaving(null)
  }

  async function remove(rule: NudgeRule) {
    if (!window.confirm(t('admin.nudge_rules.delete_confirm'))) return
    setSaving(rule.id)
    await api.delete(`/api/admin/teams/${teamId}/nudge-rules/${rule.id}`)
    setRules((prev) => prev.filter((r) => r.id !== rule.id))
    setSaving(null)
  }

  async function saveTeamIds(rule: NudgeRule, teamIds: string[]) {
    setSaving(rule.id)
    await api.patch(`/api/admin/teams/${teamId}/nudge-rules/${rule.id}`, { teamIds })
    setSaving(null)
    // Reload so the rule disappears from this team's list if it was unassigned.
    await reload()
  }

  function setTriggerType(triggerType: TriggerType) {
    setForm((f) => ({ ...f, triggerType, configJson: JSON.stringify(defaultConfig(triggerType, evalWork)) }))
  }

  async function submitCreate() {
    setError(null)
    let parsedConfig: Record<string, unknown>
    try {
      parsedConfig = JSON.parse(form.configJson) as Record<string, unknown>
    } catch {
      setError(t('admin.nudge_rules.config_invalid_json'))
      return
    }
    if (!form.name.trim()) {
      setError(t('admin.nudge_rules.name_required', 'Name is required'))
      return
    }
    if (!form.messageTemplate.trim()) {
      setError(t('admin.nudge_rules.message_required'))
      return
    }
    setSaving('add')
    const res = await api.post<NudgeRule>(`/api/admin/teams/${teamId}/nudge-rules`, {
      name: form.name.trim(),
      triggerType: form.triggerType,
      triggerConfig: parsedConfig,
      messageTemplate: form.messageTemplate.trim(),
      teamIds: form.teamIds,
      severity: form.severity,
      icon: form.icon,
      cooldownHours: form.cooldownHours,
      sendEmail: form.sendEmail,
      sendSlackDm: form.sendSlackDm,
    })
    setSaving(null)
    if (res.error || !res.data) { setError(res.error ?? 'Failed to create rule'); return }
    setAdding(false)
    setForm({ name: '', triggerType: 'no_activity_days', configJson: JSON.stringify(defaultConfig('no_activity_days', evalWork)), messageTemplate: '', teamIds: [teamId], severity: 'info', icon: null, cooldownHours: null, sendEmail: false, sendSlackDm: false })
    await reload()
  }

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {adding ? (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
          <p className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">{t('admin.nudge_rules.add_rule')}</p>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label>{t('admin.nudge_rules.name', 'Name')}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t('admin.nudge_rules.name_placeholder', 'e.g. No Activity Days')}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.nudge_rules.trigger_type')}</Label>
              <Select value={form.triggerType} onChange={(e) => setTriggerType(e.target.value as TriggerType)}>
                <option value="no_activity_days">{t('admin.nudge_rules.trigger_no_activity_days')}</option>
                <option value="stage_no_type">{t('admin.nudge_rules.trigger_stage_no_type')}</option>
                <option value="type_no_followup">{t('admin.nudge_rules.trigger_type_no_followup')}</option>
                <option value="weekly_hours_below_target">{t('admin.nudge_rules.trigger_weekly_hours_below_target')}</option>
                <option value="sf_sync_failed">{t('admin.nudge_rules.trigger_sf_sync_failed', { context: crmCtx })}</option>
                <option value="opportunity_stale">{t('admin.nudge_rules.trigger_opportunity_stale')}</option>
                <option value="product_gap">{t('admin.nudge_rules.trigger_product_gap')}</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.nudge_rules.trigger_config')}</Label>
              <Input value={form.configJson} onChange={(e) => setForm((f) => ({ ...f, configJson: e.target.value }))} className="font-mono text-xs" />
              <p className="text-[10px] text-gray-400 dark:text-gray-500">{t('admin.nudge_rules.config_hint')}</p>
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.nudge_rules.message')}</Label>
              <Textarea
                value={form.messageTemplate}
                onChange={(e) => setForm((f) => ({ ...f, messageTemplate: e.target.value }))}
                className="min-h-[60px]"
                placeholder={t('admin.nudge_rules.message_placeholder')}
              />
              <p className="text-[10px] text-gray-400 dark:text-gray-500">
                {t('admin.nudge_rules.tokens')}: {'{opp_name}'} {'{account_name}'} {'{days}'} {'{days_overdue}'} {'{user_name}'} {'{team_name}'} {'{count}'} {'{stage_name}'} {'{days_since_activity}'}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label>{t('admin.nudge_rules.severity', 'Severity')}</Label>
                <Select value={form.severity} onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value as 'info' | 'warning' | 'critical' }))}>
                  <option value="info">{t('admin.nudge_rules.severity_info', 'Info')}</option>
                  <option value="warning">{t('admin.nudge_rules.severity_warning', 'Warning')}</option>
                  <option value="critical">{t('admin.nudge_rules.severity_critical', 'Critical')}</option>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.nudge_rules.icon', 'Icon')}</Label>
                <IconPicker value={form.icon ?? undefined} onChange={(icon) => setForm((f) => ({ ...f, icon: icon || null }))} />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.nudge_rules.cooldown_hours', 'Cooldown (hours)')}</Label>
              <Input
                type="number"
                min={0}
                value={form.cooldownHours ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  setForm((f) => ({ ...f, cooldownHours: v === '' ? null : Math.max(0, Number(v)) }))
                }}
                placeholder={t('admin.nudge_rules.cooldown_placeholder', 'No cooldown')}
                className="w-40"
              />
              <p className="text-[10px] text-gray-400 dark:text-gray-500">
                {t('admin.nudge_rules.cooldown_hint', 'Minimum hours between deliveries of this rule to the same user. Leave blank to fire on every eval.')}
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={form.sendEmail}
                onChange={(e) => setForm((f) => ({ ...f, sendEmail: e.target.checked }))}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800"
              />
              <Mail className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
              {t('admin.nudge_rules.send_email', 'Also send by email')}
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={form.sendSlackDm}
                onChange={(e) => setForm((f) => ({ ...f, sendSlackDm: e.target.checked }))}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800"
              />
              <MessageSquare className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
              {t('admin.nudge_rules.send_slack_dm')}
            </label>
            {isAppAdmin && (
              <TeamAssignmentPicker selectedIds={form.teamIds} onChange={(ids) => setForm((f) => ({ ...f, teamIds: ids }))} />
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={submitCreate} disabled={saving === 'add' || !form.name.trim() || !form.messageTemplate.trim()}>
                {saving === 'add' && <Spinner className="mr-1 h-3 w-3" />}
                <Save className="mr-1 h-3.5 w-3.5" />{t('common.save')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setError(null) }}><X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}</Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-700 dark:text-gray-300">{rules.length} {t('admin.nudge_rules.count')}</p>
          <Button size="sm" onClick={() => { setAdding(true); setError(null) }}>
            <Plus className="h-4 w-4" />
            {t('admin.nudge_rules.add_rule')}
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {rules.map((rule) => {
          const open = isExpanded(rule.id)
          return (
          <div key={rule.id} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <div className="mb-2 flex items-start justify-between gap-2">
              <button type="button" onClick={() => toggleExpanded(rule.id)} className="flex flex-1 flex-wrap items-center gap-2 text-left">
                {open ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{rule.name}</span>
                <Badge variant="secondary" className="font-mono text-[10px]">{rule.triggerType}</Badge>
                <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">{JSON.stringify(rule.triggerConfig)}</span>
                {!open && (
                  <span className="ml-1 max-w-md truncate text-xs text-gray-500 dark:text-gray-400">— {rule.messageTemplate}</span>
                )}
              </button>
              <div className="flex shrink-0 items-center gap-1">
                <Badge variant={rule.isActive ? 'success' : 'outline'} className="inline-flex items-center gap-1">
                  {rule.isActive
                    ? <CheckCircle2 className="h-3 w-3" />
                    : <CircleSlash className="h-3 w-3" />}
                  {rule.isActive ? t('admin.nudge_rules.active') : t('admin.nudge_rules.inactive')}
                </Badge>
                {rule.sendEmail && (
                  <Badge variant="outline" className="inline-flex items-center gap-1 border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-300" title={t('admin.nudge_rules.send_email_on', 'Also delivered by email')}>
                    <Mail className="h-3 w-3" />
                    {t('admin.nudge_rules.email_short', 'Email')}
                  </Badge>
                )}
                {rule.sendSlackDm && (
                  <Badge variant="outline" className="inline-flex items-center gap-1 border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-300" title={t('admin.nudge_rules.send_slack_dm_on')}>
                    <MessageSquare className="h-3 w-3" />
                    {t('admin.nudge_rules.slack_dm_short')}
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={() => openPreview(rule.id)} title={t('admin.nudge_rules.preview_tip', 'Show users who would receive this nudge right now')}>
                  <Eye className="mr-1 h-3.5 w-3.5" />
                  {t('admin.nudge_rules.preview', 'Preview')}
                </Button>
                <Button variant="ghost" size="sm" disabled={saving === rule.id} onClick={() => toggleActive(rule.id, !rule.isActive)}>
                  {rule.isActive
                    ? <PowerOff className="mr-1 h-3.5 w-3.5" />
                    : <Power className="mr-1 h-3.5 w-3.5" />}
                  {rule.isActive ? t('admin.nudge_rules.disable') : t('admin.nudge_rules.enable')}
                </Button>
                <button onClick={() => remove(rule)} disabled={saving === rule.id} className="rounded p-1.5 text-gray-400 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400" aria-label={t('common.delete')}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
            {open && (<>
            <div className="mb-3 flex flex-col gap-1">
              <Label>{t('admin.nudge_rules.name', 'Name')}</Label>
              <Input
                value={editingName[rule.id] ?? rule.name}
                onChange={(e) => setEditingName((prev) => ({ ...prev, [rule.id]: e.target.value }))}
                onBlur={() => void saveName(rule.id)}
                disabled={saving === rule.id}
              />
            </div>
            <div className="mb-3 grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label>{t('admin.nudge_rules.trigger_type')}</Label>
                <Select
                  value={rule.triggerType}
                  disabled={saving === rule.id}
                  onChange={(e) => saveTriggerType(rule, e.target.value as TriggerType)}
                >
                  <option value="no_activity_days">{t('admin.nudge_rules.trigger_no_activity_days')}</option>
                  <option value="stage_no_type">{t('admin.nudge_rules.trigger_stage_no_type')}</option>
                  <option value="type_no_followup">{t('admin.nudge_rules.trigger_type_no_followup')}</option>
                  <option value="weekly_hours_below_target">{t('admin.nudge_rules.trigger_weekly_hours_below_target')}</option>
                  <option value="sf_sync_failed">{t('admin.nudge_rules.trigger_sf_sync_failed', { context: crmCtx })}</option>
                  <option value="opportunity_stale">{t('admin.nudge_rules.trigger_opportunity_stale')}</option>
                  <option value="product_gap">{t('admin.nudge_rules.trigger_product_gap')}</option>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.nudge_rules.trigger_config')}</Label>
                <Input
                  value={configDraft[rule.id] ?? JSON.stringify(rule.triggerConfig)}
                  onChange={(e) => setConfigDraft((prev) => ({ ...prev, [rule.id]: e.target.value }))}
                  onBlur={(e) => void saveTriggerConfig(rule, e.target.value)}
                  className={`font-mono text-xs ${configInvalid[rule.id] ? 'border-red-400 dark:border-red-600' : ''}`}
                  disabled={saving === rule.id}
                />
                <p className={`text-[10px] ${configInvalid[rule.id] ? 'text-red-500 dark:text-red-400' : 'text-gray-400 dark:text-gray-500'}`}>
                  {configInvalid[rule.id] ? t('admin.nudge_rules.config_invalid_json') : t('admin.nudge_rules.config_hint')}
                </p>
              </div>
            </div>
            <Textarea
              value={editing[rule.id] ?? rule.messageTemplate}
              onChange={(e) => setEditing((prev) => ({ ...prev, [rule.id]: e.target.value }))}
              className="min-h-[60px] text-sm"
            />
            {editing[rule.id] && editing[rule.id] !== rule.messageTemplate && (
              <Button size="sm" className="mt-2" onClick={() => saveMessage(rule.id)} disabled={saving === rule.id}>
                {t('admin.nudge_rules.save_message')}
              </Button>
            )}
            <p className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
              {t('admin.nudge_rules.tokens')}: {'{opp_name}'} {'{account_name}'} {'{days}'} {'{user_name}'} {'{team_name}'} {'{count}'} {'{stage_name}'} {'{days_since_activity}'}
            </p>
            <NudgeTranslationsEditor ruleId={rule.id} teamId={teamId} baseTemplate={rule.messageTemplate} />
            <div className="mt-3 grid grid-cols-2 gap-3 border-t border-gray-100 pt-3 dark:border-gray-800">
              <div className="flex flex-col gap-1">
                <Label>{t('admin.nudge_rules.severity', 'Severity')}</Label>
                <Select
                  value={rule.severity ?? 'info'}
                  onChange={async (e) => {
                    const severity = e.target.value as 'info' | 'warning' | 'critical'
                    setSaving(rule.id)
                    await api.patch(`/api/admin/teams/${teamId}/nudge-rules/${rule.id}`, { severity })
                    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, severity } : r)))
                    setSaving(null)
                  }}
                  disabled={saving === rule.id}
                >
                  <option value="info">{t('admin.nudge_rules.severity_info', 'Info')}</option>
                  <option value="warning">{t('admin.nudge_rules.severity_warning', 'Warning')}</option>
                  <option value="critical">{t('admin.nudge_rules.severity_critical', 'Critical')}</option>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.nudge_rules.icon', 'Icon')}</Label>
                <IconPicker
                  value={rule.icon ?? undefined}
                  onChange={async (icon) => {
                    setSaving(rule.id)
                    const nextIcon = icon || null
                    await api.patch(`/api/admin/teams/${teamId}/nudge-rules/${rule.id}`, { icon: nextIcon })
                    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, icon: nextIcon } : r)))
                    setSaving(null)
                  }}
                />
              </div>
              <div className="col-span-2 flex flex-col gap-1">
                <Label>{t('admin.nudge_rules.cooldown_hours', 'Cooldown (hours)')}</Label>
                <Input
                  type="number"
                  min={0}
                  value={rule.cooldownHours ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    const next = v === '' ? null : Math.max(0, Number(v))
                    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, cooldownHours: next } : r)))
                  }}
                  onBlur={async (e) => {
                    const v = e.target.value
                    const next = v === '' ? null : Math.max(0, Number(v))
                    setSaving(rule.id)
                    await api.patch(`/api/admin/teams/${teamId}/nudge-rules/${rule.id}`, { cooldownHours: next })
                    setSaving(null)
                  }}
                  placeholder={t('admin.nudge_rules.cooldown_placeholder', 'No cooldown')}
                  className="w-40"
                  disabled={saving === rule.id}
                />
                <p className="text-[10px] text-gray-400 dark:text-gray-500">
                  {t('admin.nudge_rules.cooldown_hint', 'Minimum hours between deliveries of this rule to the same user. Leave blank to fire on every eval.')}
                </p>
              </div>
              <div className="col-span-2 flex flex-col gap-1">
                <Label>{t('admin.nudge_rules.leader_rollup_threshold', 'Leader roll-up threshold')}</Label>
                <Input
                  type="number"
                  min={0}
                  value={rule.leaderRollupThreshold ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    const next = v === '' ? null : Math.max(1, Number(v))
                    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, leaderRollupThreshold: next } : r)))
                  }}
                  onBlur={async (e) => {
                    const v = e.target.value
                    const next = v === '' ? null : Math.max(1, Number(v))
                    setSaving(rule.id)
                    await api.patch(`/api/admin/teams/${teamId}/nudge-rules/${rule.id}`, { leaderRollupThreshold: next })
                    setSaving(null)
                  }}
                  placeholder={t('admin.nudge_rules.rollup_placeholder', 'Off (individual rule)')}
                  className="w-40"
                  disabled={saving === rule.id}
                />
                <p className="text-[10px] text-gray-400 dark:text-gray-500">
                  {t('admin.nudge_rules.rollup_hint', 'When set, this rule fires for team leaders whose members have this many distinct in-app deliveries of the same triggerType in the last 7 days. Use {count} in the template.')}
                </p>
              </div>
              <div className="col-span-2 flex flex-col gap-1">
                <Label>{t('admin.nudge_rules.conditions', 'AND / OR conditions')}</Label>
                <Textarea
                  value={rule.conditions ? JSON.stringify(rule.conditions, null, 0) : ''}
                  onChange={(e) => {
                    const raw = e.target.value.trim()
                    let next: NudgeRule['conditions'] = null
                    if (raw) {
                      try { next = JSON.parse(raw) } catch { return }
                    }
                    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, conditions: next } : r)))
                  }}
                  onBlur={async (e) => {
                    const raw = e.target.value.trim()
                    let next: NudgeRule['conditions'] = null
                    if (raw) {
                      try { next = JSON.parse(raw) } catch { return }
                    }
                    setSaving(rule.id)
                    await api.patch(`/api/admin/teams/${teamId}/nudge-rules/${rule.id}`, { conditions: next })
                    setSaving(null)
                  }}
                  className="min-h-[50px] font-mono text-xs"
                  placeholder='{"op":"AND","clauses":[{"triggerType":"no_activity_days","config":{"days":3}}]}'
                  disabled={saving === rule.id}
                />
                <p className="text-[10px] text-gray-400 dark:text-gray-500">
                  {t('admin.nudge_rules.conditions_hint', 'Optional JSON combinator on top of the base trigger. Shape: {op:"AND"|"OR", clauses:[{triggerType, config}]}. AND = all clauses must match; OR = any. Leave blank for single-trigger behavior.')}
                </p>
                {rule.conditions?.clauses?.some((c) => c.triggerType === rule.triggerType) && (
                  <p className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    {t('admin.nudge_rules.conditions_duplicate_warning', 'A clause here uses the same trigger type as this rule\'s own Trigger Type above, with its own separate config. Both must match to fire — if their settings disagree (e.g. different "days"), the stricter one silently wins.')}
                  </p>
                )}
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
              <input
                id={`send-email-${rule.id}`}
                type="checkbox"
                checked={rule.sendEmail}
                disabled={saving === rule.id}
                onChange={async (e) => {
                  const sendEmail = e.target.checked
                  setSaving(rule.id)
                  await api.patch(`/api/admin/teams/${teamId}/nudge-rules/${rule.id}`, { sendEmail })
                  setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, sendEmail } : r)))
                  setSaving(null)
                }}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800"
              />
              <label htmlFor={`send-email-${rule.id}`} className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
                <Mail className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                {t('admin.nudge_rules.send_email', 'Also send by email')}
              </label>
              <span className="text-[10px] text-gray-400 dark:text-gray-500">
                {t('admin.nudge_rules.send_email_hint', 'Uses the team theme email template')}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                id={`send-slack-dm-${rule.id}`}
                type="checkbox"
                checked={rule.sendSlackDm}
                disabled={saving === rule.id}
                onChange={async (e) => {
                  const sendSlackDm = e.target.checked
                  setSaving(rule.id)
                  await api.patch(`/api/admin/teams/${teamId}/nudge-rules/${rule.id}`, { sendSlackDm })
                  setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, sendSlackDm } : r)))
                  setSaving(null)
                }}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800"
              />
              <label htmlFor={`send-slack-dm-${rule.id}`} className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
                <MessageSquare className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                {t('admin.nudge_rules.send_slack_dm')}
              </label>
              <span className="text-[10px] text-gray-400 dark:text-gray-500">
                {t('admin.nudge_rules.send_slack_dm_hint')}
              </span>
            </div>
            {isAppAdmin && (
              <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
                <TeamAssignmentPicker
                  selectedIds={rule.teamIds}
                  onChange={(ids) => saveTeamIds(rule, ids)}
                  disabled={saving === rule.id}
                />
                {rule.teamIds.length === 0 && (
                  <p className="mt-1 text-xs text-amber-500 dark:text-amber-400">{t('admin.team_assignment.unassigned')}</p>
                )}
                {rule.teamIds.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {rule.teamIds.map((tid) => (
                      <Badge key={tid} variant="outline" className="text-[10px]">{teamNameById.get(tid) ?? tid.slice(0, 6)}</Badge>
                    ))}
                  </div>
                )}
              </div>
            )}
            </>)}
          </div>
        )})}
        {rules.length === 0 && !adding && (
          <p className="py-6 text-center text-sm text-gray-400 dark:text-gray-500">{t('admin.nudge_rules.empty')}</p>
        )}
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setPreview(null)}>
          <div className="max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('admin.nudge_rules.preview_title', 'Preview — who would receive this now')}</p>
                {preview.meta && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t('admin.nudge_rules.preview_meta', '{{hits}} of {{evaluated}} members match', { hits: preview.hits.length, evaluated: preview.meta.evaluated })}
                    {preview.meta.sampled && ' · sampled first 200 of ' + preview.meta.total}
                  </p>
                )}
              </div>
              <button onClick={() => setPreview(null)} className="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[64vh] overflow-y-auto">
              {/* v1.303.0: the single most useful fact in this modal when hits
                  are unexpectedly empty — literally the same junction check
                  evaluateNudges() runs to decide whether this rule is even a
                  candidate for this team, so it separates "the rule wasn't in
                  scope for this team at all" from "it was, and the trigger
                  genuinely didn't match anyone below." */}
              {!preview.loading && preview.meta && !preview.meta.ruleEligibleForTeam && (
                <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t('admin.nudge_rules.preview_not_eligible', 'This rule is either inactive or not currently assigned to this team (Assign to teams, above) — that\'s why nobody matches below, regardless of anyone\'s activity data. Nothing past this point can fire for this team until that\'s fixed.')}</span>
                </div>
              )}
              {/* v1.306.0: the per-member dismissal pill (v1.305) coming back
                  blank for every sampled member ruled out a per-user cause for
                  a "0 of N" that's symmetric across members with provably-true
                  recentCount — only a rule-wide gate explains a result that's
                  identical for everyone regardless of their own data.
                  leaderRollupThreshold is exactly that: when set, this rule's
                  per-user path is skipped unconditionally for every member,
                  full stop, and the rule can only ever fire via the separate
                  leader-rollup pass — which itself depends on nudge_events
                  rows that the (skipped) per-user path is what would normally
                  write, a self-defeating trap for a rule not actually intended
                  as a rollup. */}
              {!preview.loading && preview.meta?.isLeaderRollupRule && (
                <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t('admin.nudge_rules.preview_is_rollup', 'This rule has a Leader roll-up threshold of {{threshold}} set — that makes it a leader-rollup rule, which skips the normal per-member matching this Preview simulates entirely. It only ever fires as a single aggregated nudge to a leader, and only once {{threshold}} distinct members have already received an in-app nudge of this trigger type in the last 7 days — which can never happen while the per-member path stays skipped. If this rule was meant to nudge members individually, clear Leader roll-up threshold below.', { threshold: preview.meta?.leaderRollupThreshold ?? '?' })}</span>
                </div>
              )}
              {!preview.loading && preview.meta?.hasConditions && !preview.meta?.isLeaderRollupRule && (
                <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t('admin.nudge_rules.preview_has_conditions', 'This rule has an AND/OR condition configured below the base trigger — a member only matches when that condition ALSO holds, in addition to the base trigger. If a member here has recentCount: 0 but still isn\'t matching, check whether the condition is what\'s excluding them.')}</span>
                </div>
              )}
              {preview.loading ? (
                <div className="flex justify-center py-10"><Spinner className="h-5 w-5" /></div>
              ) : preview.hits.length === 0 ? (
                <div className="py-10 text-center">
                  <p className="text-sm text-gray-400 dark:text-gray-500">
                    {t('admin.nudge_rules.preview_empty', 'No team members would receive this nudge right now.')}
                  </p>
                  {(preview.meta?.dismissedCount ?? 0) > 0 && (
                    <p className="mx-auto mt-2 max-w-sm text-xs text-amber-600 dark:text-amber-400">
                      {t('admin.nudge_rules.preview_dismissed_note', '{{count}} member(s) currently have this exact reminder snoozed or closed out, so they\'re excluded regardless of whether it would otherwise match. That\'s likely why nobody is shown here.', { count: preview.meta?.dismissedCount ?? 0 })}
                    </p>
                  )}
                  {(preview.meta?.errorCount ?? 0) > 0 && (
                    <p className="mx-auto mt-2 max-w-sm text-xs text-red-600 dark:text-red-400">
                      {t('admin.nudge_rules.preview_error_note', 'Evaluation failed for {{count}} member(s) — check the server log for [nudge-preview] warnings.', { count: preview.meta?.errorCount ?? 0 })}
                    </p>
                  )}
                </div>
              ) : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                  {preview.hits.map((h) => (
                    <li key={h.userId} className="px-4 py-3">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{h.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{h.email}</p>
                      <p className="mt-1 text-xs text-gray-700 dark:text-gray-300">{h.message}</p>
                    </li>
                  ))}
                </ul>
              )}
              {!preview.loading && preview.meta?.activityDiagnostics && preview.meta.activityDiagnostics.length > 0 && (
                <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-800">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                    {t('admin.nudge_rules.preview_activity_diagnostics_title', 'Last logged activity per member — this is what "no activity" is measured against')}
                  </p>
                  <ul className="space-y-1">
                    {preview.meta.activityDiagnostics.map((d) => (
                      <li key={d.userId} className="flex items-center justify-between text-xs">
                        <span className="text-gray-700 dark:text-gray-300">{d.name}</span>
                        <span className="flex items-center gap-2">
                          <span className="text-gray-500 dark:text-gray-400">{formatLastActivity(d.lastActivityAt, t)}</span>
                          {/* v1.304.0: the trigger's own count(*) for this exact
                              member — 0 means "this rule's own query says they
                              should match." If this ever disagrees with the
                              last-activity date shown to its left, that's the
                              proof point that settles whether the remaining
                              gap is a live-query anomaly rather than trigger
                              logic (already individually ruled out). */}
                          {d.recentCount !== undefined && (
                            <span
                              className={d.recentCount === 0
                                ? 'rounded bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                                : 'rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400'}
                              title={t('admin.nudge_rules.preview_recent_count_tip', 'Activities counted by this rule\'s own query within its configured window — 0 means the trigger itself says this member should match.')}
                            >
                              {t('admin.nudge_rules.preview_recent_count', 'count: {{count}}', { count: d.recentCount })}
                            </span>
                          )}
                          {/* v1.305.0: per-member dismissal state for THIS rule.
                              The aggregate dismissedCount note above only fires
                              when >0 and never says which members — a member
                              whose recentCount already proves the trigger true
                              can still be silently excluded by their own active
                              snooze/close-out, which otherwise looks identical
                              to "genuinely doesn't match" from this list alone. */}
                          {d.dismissed && (
                            <span
                              className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                              title={d.dismissed === 'permanent'
                                ? t('admin.nudge_rules.preview_dismissed_permanent_tip', 'This member closed this reminder out permanently — it will never fire for them again until they (or an admin) clears it.')
                                : t('admin.nudge_rules.preview_dismissed_snoozed_tip', 'This member snoozed this reminder until {{until}} — excluded from hits until then even though the trigger currently matches.', { until: d.dismissedUntil ? new Date(d.dismissedUntil).toLocaleString() : '' })}
                            >
                              {d.dismissed === 'permanent'
                                ? t('admin.nudge_rules.preview_dismissed_permanent', 'closed out')
                                : t('admin.nudge_rules.preview_dismissed_snoozed', 'snoozed')}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// v1.125.0: compact per-locale translations editor. Admin picks a
// language, types the localized message, and saves — server upserts a
// row on nudge_rule_translations. Server picks the row matching the
// caller's locale at read time and falls back to messageTemplate when
// unset. Trash icon deletes a translation (back to base template).
const LOCALES: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'ja', label: '日本語' },
  { code: 'pt', label: 'Português' },
]

function NudgeTranslationsEditor({ ruleId, teamId, baseTemplate }: { ruleId: string; teamId: string; baseTemplate: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [locale, setLocale] = useState<string>('es')
  const [translations, setTranslations] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<string>('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    void api.get<Array<{ locale: string; messageTemplate: string }>>(
      `/api/admin/teams/${teamId}/nudge-rules/${ruleId}/translations`,
    ).then((res) => {
      const map: Record<string, string> = {}
      for (const r of res.data ?? []) map[r.locale] = r.messageTemplate
      setTranslations(map)
    })
  }, [open, ruleId, teamId])

  useEffect(() => { setDraft(translations[locale] ?? '') }, [locale, translations])

  async function save() {
    setBusy(true)
    await api.put(`/api/admin/teams/${teamId}/nudge-rules/${ruleId}/translations/${locale}`, { messageTemplate: draft })
    setTranslations((prev) => ({ ...prev, [locale]: draft }))
    setBusy(false)
  }
  async function remove() {
    setBusy(true)
    await api.delete(`/api/admin/teams/${teamId}/nudge-rules/${ruleId}/translations/${locale}`)
    setTranslations((prev) => { const n = { ...prev }; delete n[locale]; return n })
    setDraft('')
    setBusy(false)
  }

  const existing = translations[locale] ?? null
  const dirty = draft !== (existing ?? '')

  return (
    <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-200"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Languages className="h-3.5 w-3.5" />
        {t('admin.nudge_rules.translations', 'Translations')}
        <span className="ml-1 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-800 dark:bg-blue-950 dark:text-blue-200">
          {Object.keys(translations).length}
        </span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Label className="text-xs">{t('admin.nudge_rules.language', 'Language')}</Label>
            <Select value={locale} onChange={(e) => setLocale(e.target.value)} className="w-40">
              {LOCALES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label} ({l.code}){translations[l.code] ? ' •' : ''}
                </option>
              ))}
            </Select>
          </div>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={baseTemplate}
            className="min-h-[52px] text-xs"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={busy || !dirty || draft.trim() === ''}>
              <Save className="mr-1 h-3 w-3" />
              {t('admin.nudge_rules.save_translation', 'Save translation')}
            </Button>
            {existing && (
              <Button size="sm" variant="ghost" onClick={remove} disabled={busy}>
                <Trash2 className="mr-1 h-3 w-3" />
                {t('admin.nudge_rules.reset_to_base', 'Use base message')}
              </Button>
            )}
          </div>
          <p className="text-[10px] text-gray-500 dark:text-gray-400">
            {t('admin.nudge_rules.translations_hint', 'Users seeing the app in this language will get this message instead of the base template. Same tokens work: {{tokens}}.', { tokens: '{opp_name} {account_name} {days} {user_name} {team_name} {count}' })}
          </p>
        </div>
      )}
    </div>
  )
}
