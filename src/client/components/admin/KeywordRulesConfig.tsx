import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Pencil, Sparkles, Save, X, CalendarOff, Info, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Select } from '../ui/select.js'
import { Badge } from '../ui/badge.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { TeamAssignmentPicker } from './TeamAssignmentPicker.js'
import { useTeam } from '../../hooks/useTeam.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'

interface KeywordRule {
  id: string
  teamId: string | null
  keywords: string[]
  // v1.240.0: null when action = 'mark_non_activity'.
  activityTypeId: string | null
  matchField: 'subject' | 'body' | 'both'
  priority: number
  isActive: boolean
  teamIds: string[]
  action: 'suggest_type' | 'mark_non_activity'
  // v1.468.0: the rule's type as THIS team sees it. A rule shared from
  // another team stores that team's type id; the server resolves it to this
  // team's type of the same name.
  teamActivityTypeId?: string | null
  activityTypeName?: string | null
}

interface ReplacedRule { ruleId: string; teamId: string; teamName: string; deleted: boolean }

interface ActivityType {
  id: string
  name: string
}

interface RuleFormState {
  keywords: string
  // Either a real activity-type id, or the NON_ACTIVITY sentinel below.
  activityTypeId: string
  matchField: 'subject' | 'body' | 'both'
  priority: string
  isActive: boolean
  teamIds: string[]
}

// v1.240.0: sentinel option folded into the SAME Activity Type dropdown other
// rules use, rather than a separate Action selector — "Non-Activity" reads as
// one more choice among the activity types, matching how every other
// keyword rule already picks from that same list.
const NON_ACTIVITY = '__non_activity__'

const emptyForm = (activityTypes: ActivityType[], defaultTeamIds: string[]): RuleFormState => ({
  keywords: '',
  activityTypeId: activityTypes[0]?.id ?? '',
  matchField: 'subject',
  priority: '10',
  isActive: true,
  teamIds: defaultTeamIds,
})

export function KeywordRulesConfig({ teamId }: { teamId: string }) {
  const { t } = useTranslation()
  const { teams } = useTeam()
  const { user } = useCurrentUser()
  const isAppAdmin = user?.isAppAdmin ?? false
  const [rules, setRules] = useState<KeywordRule[]>([])
  const [activityTypes, setActivityTypes] = useState<ActivityType[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<RuleFormState | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)
  const [testInput, setTestInput] = useState('')
  const [testLoading, setTestLoading] = useState(false)
  const [testResult, setTestResult] = useState<{ activityTypeName: string | null; confidence: number; source: string; action?: 'suggest_type' | 'mark_non_activity' } | null>(null)

  const teamNameById = new Map(teams.map((tm) => [tm.id, tm.name]))

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.get<KeywordRule[]>(`/api/admin/teams/${teamId}/keyword-rules`),
      api.get<ActivityType[]>(`/api/teams/${teamId}/activity-types`),
    ]).then(([rulesRes, typesRes]) => {
      setRules(rulesRes.data ?? [])
      setActivityTypes(typesRes.data ?? [])
      setLoading(false)
    })
  }, [teamId])

  // v1.468.0: saving a rule to other teams replaces each team's rule it fully
  // covers; say which teams, since the admin can't see those lists from here.
  function noteReplaced(meta: Record<string, unknown>) {
    const replaced = Array.isArray(meta['replaced']) ? (meta['replaced'] as ReplacedRule[]) : []
    if (replaced.length === 0) return
    const names = [...new Set(replaced.map((r) => r.teamName))].join(', ')
    setNotice({ kind: 'info', text: t('admin.keyword_rules.replaced_in_teams', { count: replaced.length, teams: names }) })
  }

  function openCreate() {
    setNotice(null)
    setEditingId(null)
    setForm(emptyForm(activityTypes, [teamId]))
  }

  function openEdit(rule: KeywordRule) {
    setNotice(null)
    setEditingId(rule.id)
    setForm({
      keywords: rule.keywords.join(', '),
      activityTypeId: rule.action === 'mark_non_activity' ? NON_ACTIVITY : (rule.teamActivityTypeId ?? rule.activityTypeId ?? (activityTypes[0]?.id ?? '')),
      matchField: rule.matchField,
      priority: String(rule.priority),
      isActive: rule.isActive,
      teamIds: rule.teamIds,
    })
  }

  function cancelForm() {
    setForm(null)
    setEditingId(null)
  }

  async function saveRule() {
    if (!form) return
    setSaving(true)
    const isNonActivity = form.activityTypeId === NON_ACTIVITY
    const body = {
      keywords: form.keywords.split(',').map((k) => k.trim()).filter(Boolean),
      activityTypeId: isNonActivity ? null : form.activityTypeId,
      matchField: form.matchField,
      priority: Number(form.priority),
      isActive: form.isActive,
      teamIds: form.teamIds,
      action: isNonActivity ? 'mark_non_activity' as const : 'suggest_type' as const,
    }
    const res = editingId
      ? await api.patch<KeywordRule>(`/api/admin/teams/${teamId}/keyword-rules/${editingId}`, body)
      : await api.post<KeywordRule>(`/api/admin/teams/${teamId}/keyword-rules`, body)
    setSaving(false)
    if (!res.data) {
      // Keep the form open so the admin can fix the scope or type.
      setNotice({ kind: 'error', text: res.error ?? t('errors.server') })
      return
    }
    // Reload: the scope may have dropped this team, and the server resolves
    // each rule's type name for this team.
    const refreshed = await api.get<KeywordRule[]>(`/api/admin/teams/${teamId}/keyword-rules`)
    setRules(refreshed.data ?? [])
    setNotice(null)
    noteReplaced(res.meta)
    cancelForm()
  }

  async function deleteRule(id: string) {
    setDeleting(id)
    await api.delete(`/api/admin/teams/${teamId}/keyword-rules/${id}`)
    setRules((r) => r.filter((x) => x.id !== id))
    setDeleting(null)
  }

  async function toggleActive(rule: KeywordRule) {
    const res = await api.patch<KeywordRule>(`/api/admin/teams/${teamId}/keyword-rules/${rule.id}`, { isActive: !rule.isActive })
    if (res.data) setRules((r) => r.map((x) => (x.id === rule.id ? res.data! : x)))
    else setNotice({ kind: 'error', text: res.error ?? t('errors.server') })
  }

  async function saveTeamIds(rule: KeywordRule, ids: string[]) {
    const res = await api.patch<KeywordRule>(`/api/admin/teams/${teamId}/keyword-rules/${rule.id}`, { teamIds: ids })
    if (!res.data) { setNotice({ kind: 'error', text: res.error ?? t('errors.server') }); return }
    setNotice(null)
    noteReplaced(res.meta)
    {
      // Reload so rules not assigned to current team disappear from the list
      const refreshed = await api.get<KeywordRule[]>(`/api/admin/teams/${teamId}/keyword-rules`)
      setRules(refreshed.data ?? [])
    }
  }

  async function runTest() {
    if (!testInput.trim()) return
    setTestLoading(true)
    setTestResult(null)
    const res = await api.post<{ activityTypeName: string | null; confidence: number; source: string }>('/api/ai/classify', { teamId, subject: testInput })
    setTestResult(res.data ?? null)
    setTestLoading(false)
  }

  // Never show a raw id: a rule shared from another team carries that team's
  // type id, so fall back to the name the server resolved for this team.
  const getTypeName = (rule: KeywordRule) =>
    activityTypes.find((at) => at.id === (rule.teamActivityTypeId ?? rule.activityTypeId))?.name
    ?? rule.activityTypeName
    ?? t('admin.keyword_rules.type_unknown')

  if (loading) {
    return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Test panel */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/30">
        <p className="mb-2 text-xs font-semibold text-blue-700 dark:text-blue-300">{t('admin.keyword_rules.test_input')}</p>
        <div className="flex gap-2">
          <Input value={testInput} onChange={(e) => setTestInput(e.target.value)} placeholder={t('admin.keyword_rules.test_placeholder')} onKeyDown={(e) => { if (e.key === 'Enter') runTest() }} />
          <Button onClick={runTest} disabled={testLoading || !testInput.trim()} size="sm">
            {testLoading ? <Spinner className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
            {t('admin.keyword_rules.test_run')}
          </Button>
        </div>
        {testResult && (
          <div className="mt-2 flex items-center gap-2 text-sm">
            <span className="text-gray-600 dark:text-gray-400">{t('admin.keyword_rules.test_result')}:</span>
            {testResult.action === 'mark_non_activity' ? (
              <>
                <Badge variant="secondary" className="gap-1">
                  <CalendarOff className="h-3 w-3" />
                  {t('admin.keyword_rules.action_mark_non_activity', 'Mark as Non-Activity')}
                </Badge>
                <span className="text-xs text-gray-500 dark:text-gray-400">{Math.round(testResult.confidence * 100)}% · {t(`admin.keyword_rules.source_${testResult.source}`)}</span>
              </>
            ) : testResult.activityTypeName ? (
              <>
                <Badge variant="default">{testResult.activityTypeName}</Badge>
                <span className="text-xs text-gray-500 dark:text-gray-400">{Math.round(testResult.confidence * 100)}% · {t(`admin.keyword_rules.source_${testResult.source}`)}</span>
              </>
            ) : (
              <span className="text-gray-400 dark:text-gray-500">{t('admin.keyword_rules.no_match')}</span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{rules.length} {t('admin.keyword_rules.rules_count')}</p>
        <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4" />{t('admin.keyword_rules.add_rule')}</Button>
      </div>

      {/* v1.241.0: what happens to a meeting NO rule below matches — the one
          thing this page can't show by listing rules, and the question an
          admin asks as soon as they see the list is finite. */}
      <div className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
        <span>{t('admin.keyword_rules.unmatched_info')}</span>
      </div>

      {notice && (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={notice.kind === 'error'
            ? 'flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300'
            : 'flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300'}
        >
          {notice.kind === 'error' ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span className="flex-1">{notice.text}</span>
          <button onClick={() => setNotice(null)} title={t('common.close')} aria-label={t('common.close')} className="shrink-0 opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {form && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
          <p className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">
            {editingId ? t('admin.keyword_rules.edit_rule') : t('admin.keyword_rules.add_rule')}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 flex flex-col gap-1">
              <Label>{t('admin.keyword_rules.keywords')}</Label>
              <Input value={form.keywords} onChange={(e) => setForm((f) => f ? { ...f, keywords: e.target.value } : f)} placeholder={t('admin.keyword_rules.keywords_placeholder')} />
            </div>
            {/* v1.240.0: "Non-Activity" is the last entry in this SAME
                dropdown rather than a separate Action field — it reads as one
                more thing a match can resolve to, the same way it already
                does for every real activity type. */}
            <div className="flex flex-col gap-1">
              <Label>{t('activity.form.type_label')}</Label>
              <Select value={form.activityTypeId} onChange={(e) => setForm((f) => f ? { ...f, activityTypeId: e.target.value } : f)}>
                {activityTypes.map((at) => <option key={at.id} value={at.id}>{at.name}</option>)}
                <option value={NON_ACTIVITY}>{t('admin.keyword_rules.non_activity_option', 'Non-Activity')}</option>
              </Select>
              {form.activityTypeId === NON_ACTIVITY && (
                <p className="text-[10px] text-gray-500 dark:text-gray-400">
                  {t('admin.keyword_rules.non_activity_hint', 'Matching meetings are auto-flagged Non-Activity instead of suggesting a type — same as clicking Non-Activity by hand, and just as reversible via Mark as Activity.')}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.keyword_rules.match_field')}</Label>
              <Select value={form.matchField} onChange={(e) => setForm((f) => f ? { ...f, matchField: e.target.value as 'subject' | 'body' | 'both' } : f)}>
                <option value="subject">{t('admin.keyword_rules.match_subject')}</option>
                <option value="body">{t('admin.keyword_rules.match_body')}</option>
                <option value="both">{t('admin.keyword_rules.match_both')}</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.keyword_rules.priority')}</Label>
              <Input type="number" min="1" value={form.priority} onChange={(e) => setForm((f) => f ? { ...f, priority: e.target.value } : f)} />
            </div>
          </div>
          {isAppAdmin && (
            <div className="mt-3">
              <TeamAssignmentPicker selectedIds={form.teamIds} onChange={(ids) => setForm((f) => f ? { ...f, teamIds: ids } : f)} />
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <Button onClick={saveRule} disabled={saving} size="sm">{saving && <Spinner className="mr-1 h-3 w-3" />}<Save className="mr-1 h-3.5 w-3.5" />{t('common.save')}</Button>
            <Button variant="ghost" size="sm" onClick={cancelForm}><X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}</Button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="w-full text-sm text-gray-900 dark:text-gray-100">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-xs font-medium text-gray-500 uppercase dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
              <th className="px-4 py-3 text-left">{t('admin.keyword_rules.keywords')}</th>
              <th className="px-4 py-3 text-left">{t('activity.form.type_label')}</th>
              <th className="px-4 py-3 text-left">{t('admin.keyword_rules.match_field')}</th>
              <th className="px-4 py-3 text-left">{t('admin.keyword_rules.priority')}</th>
              <th className="px-4 py-3 text-left">{t('admin.activity_types.scope')}</th>
              <th className="px-4 py-3 text-left">{t('admin.picklist.status')}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {rules.map((rule) => (
              <tr key={rule.id} className="theme-card">
                <td className="px-4 py-3 text-gray-900 dark:text-gray-100">
                  <div className="flex flex-wrap gap-1">
                    {rule.keywords.map((kw) => (
                      <span key={kw} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">{kw}</span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                  {rule.action === 'mark_non_activity' ? (
                    <Badge variant="secondary" className="gap-1">
                      <CalendarOff className="h-3 w-3" />
                      {t('admin.keyword_rules.action_mark_non_activity', 'Mark as Non-Activity')}
                    </Badge>
                  ) : (
                    getTypeName(rule)
                  )}
                </td>
                <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{rule.matchField}</td>
                <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{rule.priority}</td>
                <td className="px-4 py-3">
                  {isAppAdmin ? (
                    <details className="group">
                      <summary className="cursor-pointer list-none">
                        <div className="flex flex-wrap gap-1">
                          {rule.teamIds.length === 0 ? (
                            <span className="text-xs text-amber-500 dark:text-amber-400">{t('admin.team_assignment.unassigned')}</span>
                          ) : (
                            rule.teamIds.map((tid) => (
                              <Badge key={tid} variant="outline" className="text-[10px]">{teamNameById.get(tid) ?? tid.slice(0, 6)}</Badge>
                            ))
                          )}
                        </div>
                      </summary>
                      <div className="mt-2">
                        <TeamAssignmentPicker
                          selectedIds={rule.teamIds}
                          onChange={(ids) => saveTeamIds(rule, ids)}
                        />
                      </div>
                    </details>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {rule.teamIds.length === 0 ? (
                        <span className="text-xs text-amber-500 dark:text-amber-400">{t('admin.team_assignment.unassigned')}</span>
                      ) : (
                        rule.teamIds.map((tid) => (
                          <Badge key={tid} variant="outline" className="text-[10px]">{teamNameById.get(tid) ?? tid.slice(0, 6)}</Badge>
                        ))
                      )}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => toggleActive(rule)}>
                    <Badge variant={rule.isActive ? 'success' : 'secondary'}>{rule.isActive ? t('admin.picklist.active') : t('admin.picklist.inactive')}</Badge>
                  </button>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => openEdit(rule)} className="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><Pencil className="h-3.5 w-3.5" /></button>
                    <button onClick={() => deleteRule(rule.id)} disabled={deleting === rule.id} className="rounded p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400">
                      {deleting === rule.id ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('admin.keyword_rules.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
