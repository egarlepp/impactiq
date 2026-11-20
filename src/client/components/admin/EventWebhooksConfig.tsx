import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  CheckCircle2,
  CircleSlash,
  Clock,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCcw,
  Save,
  Search,
  Send,
  Trash2,
  Webhook,
  X,
  XCircle,
} from 'lucide-react'
import { api, localizeError } from '../../lib/api.js'
import { formatDateTimeInTZ } from '../../lib/tz.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { SingleSelect } from '../ui/single-select.js'
import { Spinner } from '../ui/spinner.js'
import { EVENT_TYPES, TEST_EVENT_TYPE, type EventType } from '../../../shared/eventWebhooks.js'

// Admin → Integrations → Event Webhooks (docs/event-webhooks.md). Each webhook
// gets a signed POST when one of its events happens; deliveries retry on their
// own and the log below shows what was sent and how the URL answered.

interface WebhookView {
  id: string
  name: string
  url: string
  events: string[]
  teamIds: string[]
  userIds: string[]
  allowPrivateNetwork: boolean
  isActive: boolean
  pending: number
  delivered7d: number
  failed7d: number
  lastDeliveredAt: string | null
}

interface DeliveryView {
  id: string
  webhookId: string
  eventId: string
  eventType: string
  status: 'pending' | 'delivered' | 'failed'
  attempts: number
  nextAttemptAt: string
  lastStatusCode: number | null
  lastError: string | null
  deliveredAt: string | null
  createdAt: string
}

interface State { webhooks: WebhookView[]; deliveries: DeliveryView[] }

interface FormState {
  id: string | null
  name: string
  url: string
  events: EventType[]
  teamIds: string[]
  userIds: string[]
  allowPrivateNetwork: boolean
  isActive: boolean
}

interface SendResult { ok: boolean; statusCode: number | null; error: string | null }

interface PersonOption { id: string; displayName: string | null; email: string | null; supportedTeamIds: string[]; disabledAt: string | null }

const PEOPLE_SHOWN = 8

const CARD = 'flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900'

function formFor(w: WebhookView | null): FormState {
  if (!w) return { id: null, name: '', url: '', events: ['activity.submitted'], teamIds: [], userIds: [], allowPrivateNetwork: false, isActive: true }
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    events: w.events.filter((e): e is EventType => (EVENT_TYPES as readonly string[]).includes(e)),
    teamIds: w.teamIds,
    userIds: w.userIds,
    allowPrivateNetwork: w.allowPrivateNetwork,
    isActive: w.isActive,
  }
}

function bodyFor(f: FormState) {
  return {
    name: f.name.trim(),
    url: f.url.trim(),
    events: f.events,
    teamIds: f.teamIds,
    userIds: f.userIds,
    allowPrivateNetwork: f.allowPrivateNetwork,
    isActive: f.isActive,
  }
}

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item]
}

export function EventWebhooksConfig() {
  const { t } = useTranslation()
  const [state, setState] = useState<State | null>(null)
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([])
  const [people, setPeople] = useState<PersonOption[]>([])
  const [personQuery, setPersonQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [revealed, setRevealed] = useState<{ name: string; secret: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [testResults, setTestResults] = useState<Record<string, SendResult>>({})
  const [filter, setFilter] = useState('')
  const [payloads, setPayloads] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    const qs = filter ? `?webhookId=${encodeURIComponent(filter)}` : ''
    const res = await api.get<State>(`/api/admin/event-webhooks${qs}`)
    if (res.error || !res.data) { setError(localizeError(res.error) ?? t('errors.network')); return }
    setState(res.data)
  }, [filter, t])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    void api.get<{ id: string; name: string }[]>('/api/admin/teams').then((res) => { if (res.data) setTeams(res.data) })
    void api.get<PersonOption[]>('/api/admin/users').then((res) => { if (res.data) setPeople(res.data) })
  }, [])

  async function run(key: string, fn: () => Promise<{ error?: string | null }>): Promise<boolean> {
    setBusy(key)
    setError(null)
    const res = await fn()
    setBusy(null)
    if (res.error) { setError(localizeError(res.error) ?? t('errors.network')); return false }
    await load()
    return true
  }

  async function save() {
    if (!form) return
    const name = form.name.trim()
    if (form.id) {
      const ok = await run('form', () => api.patch(`/api/admin/event-webhooks/${form.id}`, bodyFor(form)))
      if (ok) setForm(null)
      return
    }
    setBusy('form')
    setError(null)
    const res = await api.post<{ secret: string }>('/api/admin/event-webhooks', bodyFor(form))
    setBusy(null)
    if (res.error || !res.data) { setError(localizeError(res.error ?? null) ?? t('errors.network')); return }
    setRevealed({ name, secret: res.data.secret })
    setCopied(false)
    setForm(null)
    await load()
  }

  async function setActive(w: WebhookView, isActive: boolean) {
    if (!isActive && w.pending > 0 && !window.confirm(t('event_webhooks.turn_off_confirm', { count: w.pending }))) return
    await run(`active:${w.id}`, () => api.patch(`/api/admin/event-webhooks/${w.id}`, bodyFor({ ...formFor(w), isActive })))
  }

  async function remove(w: WebhookView) {
    if (!window.confirm(t('event_webhooks.delete_confirm', { name: w.name }))) return
    await run(`delete:${w.id}`, () => api.delete(`/api/admin/event-webhooks/${w.id}`))
  }

  async function rotate(w: WebhookView) {
    if (!window.confirm(t('event_webhooks.rotate_confirm', { name: w.name }))) return
    setBusy(`rotate:${w.id}`)
    setError(null)
    const res = await api.post<{ secret: string }>(`/api/admin/event-webhooks/${w.id}/rotate-secret`, {})
    setBusy(null)
    if (res.error || !res.data) { setError(localizeError(res.error ?? null) ?? t('errors.network')); return }
    setRevealed({ name: w.name, secret: res.data.secret })
    setCopied(false)
  }

  async function test(w: WebhookView) {
    setBusy(`test:${w.id}`)
    setError(null)
    const res = await api.post<SendResult>(`/api/admin/event-webhooks/${w.id}/test`, {})
    setBusy(null)
    if (res.error || !res.data) { setError(localizeError(res.error ?? null) ?? t('errors.network')); return }
    setTestResults((prev) => ({ ...prev, [w.id]: res.data! }))
    await load()
  }

  async function retry(body: { deliveryId: string } | { webhookId: string }, key: string) {
    await run(key, () => api.post('/api/admin/event-webhooks/retry', body))
  }

  async function togglePayload(d: DeliveryView) {
    if (payloads[d.id] !== undefined) {
      setPayloads((prev) => { const next = { ...prev }; delete next[d.id]; return next })
      return
    }
    const res = await api.get<{ payload: unknown }>(`/api/admin/event-webhooks/deliveries/${d.id}`)
    if (res.error || !res.data) { setError(localizeError(res.error) ?? t('errors.network')); return }
    setPayloads((prev) => ({ ...prev, [d.id]: JSON.stringify(res.data!.payload, null, 2) }))
  }

  async function copySecret() {
    if (!revealed) return
    try {
      await navigator.clipboard.writeText(revealed.secret)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  if (!state) {
    return (
      <div className={CARD}>
        {error ? <Notice tone="red" message={error} /> : <div className="flex justify-center py-4"><Spinner className="h-5 w-5" /></div>}
      </div>
    )
  }

  const nameOf = new Map(state.webhooks.map((w) => [w.id, w.name]))
  const teamName = new Map(teams.map((tm) => [tm.id, tm.name]))
  const personName = new Map(people.map((p) => [p.id, p.displayName ?? p.email ?? p.id]))
  const query = personQuery.trim().toLowerCase()
  // Offer people from the ticked teams (everyone when none is ticked).
  const personMatches = form
    ? people
      .filter((p) => !form.userIds.includes(p.id))
      .filter((p) => form.teamIds.length === 0 || p.supportedTeamIds.some((id) => form.teamIds.includes(id)))
      .filter((p) => !query || (p.displayName ?? '').toLowerCase().includes(query) || (p.email ?? '').toLowerCase().includes(query))
    : []
  const formComplete = form ? form.name.trim().length > 0 && form.url.trim().length > 0 && form.events.length > 0 : false
  const eventLabel = (type: string) => (type === TEST_EVENT_TYPE ? t('event_webhooks.events.test') : t(`event_webhooks.events.${type.replace('.', '_')}`))

  return (
    <div className="flex flex-col gap-6">
      {error && <Notice tone="red" message={error} />}

      {revealed && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="inline-flex items-center gap-2 font-medium"><KeyRound className="h-4 w-4" />{t('event_webhooks.secret_title', { name: revealed.name })}</p>
          <p className="text-xs">{t('event_webhooks.secret_hint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-white px-2 py-1 font-mono text-xs text-gray-900 dark:bg-gray-900 dark:text-gray-100">{revealed.secret}</code>
            <Button size="sm" variant="outline" onClick={() => { void copySecret() }}>
              {copied ? <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
              {copied ? t('event_webhooks.copied') : t('event_webhooks.copy')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setRevealed(null)}>
              <X className="mr-1 h-3.5 w-3.5" />{t('event_webhooks.secret_done')}
            </Button>
          </div>
        </div>
      )}

      <div className={CARD}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-gray-100 p-2 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              <Webhook className="h-4 w-4" />
            </div>
            <div>
              <p className="font-medium text-gray-900 dark:text-gray-100">{t('event_webhooks.title')}</p>
              <p className="mt-1 max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('event_webhooks.description')}</p>
            </div>
          </div>
          {!form && (
            <Button size="sm" disabled={busy !== null} onClick={() => setForm(formFor(null))}>
              <Plus className="mr-1 h-3.5 w-3.5" />{t('event_webhooks.add')}
            </Button>
          )}
        </div>

        {form && (
          <div className="flex flex-col gap-4 rounded-md border border-gray-200 p-4 dark:border-gray-700">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ewh-name">{t('event_webhooks.fields.name')}</Label>
                <Input id="ewh-name" value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('event_webhooks.fields.name_placeholder')} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ewh-url">{t('event_webhooks.fields.url')}</Label>
                <Input id="ewh-url" value={form.url} maxLength={2000} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://" />
              </div>
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-gray-900 dark:text-gray-100">{t('event_webhooks.fields.events')}</legend>
              {EVENT_TYPES.map((type) => (
                <label key={type} className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
                  <input type="checkbox" className="mt-0.5" checked={form.events.includes(type)} onChange={() => setForm({ ...form, events: toggle(form.events, type) })} />
                  <span>
                    <span className="font-medium">{eventLabel(type)}</span>
                    <code className="ml-1.5 text-xs text-gray-500 dark:text-gray-400">{type}</code>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">{t(`event_webhooks.event_hints.${type.replace('.', '_')}`)}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-gray-900 dark:text-gray-100">{t('event_webhooks.fields.teams')}</legend>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('event_webhooks.fields.teams_hint')}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {teams.map((tm) => (
                  <label key={tm.id} className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                    <input type="checkbox" checked={form.teamIds.includes(tm.id)} onChange={() => setForm({ ...form, teamIds: toggle(form.teamIds, tm.id) })} />
                    {tm.name}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-gray-900 dark:text-gray-100">{t('event_webhooks.fields.people')}</legend>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('event_webhooks.fields.people_hint')}</p>
              {form.userIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {form.userIds.map((id) => (
                    <span key={id} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
                      {personName.get(id) ?? id}
                      <button
                        type="button"
                        className="text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
                        aria-label={t('event_webhooks.fields.people_remove', { name: personName.get(id) ?? id })}
                        title={t('event_webhooks.fields.people_remove', { name: personName.get(id) ?? id })}
                        onClick={() => setForm({ ...form, userIds: form.userIds.filter((u) => u !== id) })}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="relative max-w-sm">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
                <Input
                  className="pl-8"
                  value={personQuery}
                  onChange={(e) => setPersonQuery(e.target.value)}
                  placeholder={t('event_webhooks.fields.people_search')}
                  aria-label={t('event_webhooks.fields.people_search')}
                />
              </div>
              {query && (
                <div className="flex max-w-sm flex-col gap-1">
                  {personMatches.length === 0 && <p className="text-xs text-gray-500 dark:text-gray-400">{t('event_webhooks.fields.people_none')}</p>}
                  {personMatches.slice(0, PEOPLE_SHOWN).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="flex items-center gap-2 rounded px-1.5 py-1 text-left text-sm text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                      onClick={() => { setForm({ ...form, userIds: [...form.userIds, p.id] }); setPersonQuery('') }}
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0 text-gray-500 dark:text-gray-400" />
                      <span>
                        {p.displayName ?? p.email}
                        {p.email && p.displayName && <span className="ml-1.5 text-xs text-gray-500 dark:text-gray-400">{p.email}</span>}
                      </span>
                    </button>
                  ))}
                  {personMatches.length > PEOPLE_SHOWN && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">{t('event_webhooks.fields.people_more', { count: personMatches.length - PEOPLE_SHOWN })}</p>
                  )}
                </div>
              )}
            </fieldset>

            <label className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
              <input type="checkbox" className="mt-0.5" checked={form.allowPrivateNetwork} onChange={(e) => setForm({ ...form, allowPrivateNetwork: e.target.checked })} />
              <span>
                {t('event_webhooks.fields.private_network')}
                <span className="block text-xs text-gray-500 dark:text-gray-400">{t('event_webhooks.fields.private_network_hint')}</span>
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
              {t('event_webhooks.fields.active')}
            </label>
            {!form.id && <p className="text-xs text-gray-500 dark:text-gray-400">{t('event_webhooks.fields.secret_note')}</p>}

            <div className="flex gap-2">
              <Button size="sm" disabled={!formComplete || busy !== null} onClick={() => { void save() }}>
                {busy === 'form' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Save className="mr-1 h-3.5 w-3.5" />}{t('common.save')}
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setForm(null)}>
                <X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}
              </Button>
            </div>
          </div>
        )}

        {state.webhooks.length === 0 && !form && (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('event_webhooks.empty')}</p>
        )}

        {state.webhooks.map((w) => {
          const result = testResults[w.id]
          return (
            <div key={w.id} className="flex flex-col gap-2 rounded-md border border-gray-200 p-4 dark:border-gray-700">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-gray-100">{w.name}</span>
                    <Badge variant={w.isActive ? 'success' : 'secondary'} className="inline-flex items-center gap-1">
                      {w.isActive ? <CheckCircle2 className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
                      {w.isActive ? t('event_webhooks.active') : t('event_webhooks.inactive')}
                    </Badge>
                  </div>
                  <p className="mt-0.5 break-all font-mono text-xs text-gray-500 dark:text-gray-400">{w.url}</p>
                  <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                    {w.events.map(eventLabel).join(', ')}
                    {' · '}
                    {w.teamIds.length === 0
                      ? t('event_webhooks.all_teams')
                      : w.teamIds.map((id) => teamName.get(id) ?? id).join(', ')}
                    {w.userIds.length > 0 && <> · {w.userIds.map((id) => personName.get(id) ?? id).join(', ')}</>}
                  </p>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('event_webhooks.stats', { delivered: w.delivered7d, failed: w.failed7d, pending: w.pending })}
                    {w.lastDeliveredAt && <> · {t('event_webhooks.last_delivered', { when: formatDateTimeInTZ(w.lastDeliveredAt) })}</>}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void test(w) }}>
                    {busy === `test:${w.id}` ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Send className="mr-1 h-3.5 w-3.5" />}{t('event_webhooks.test')}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setForm(formFor(w))}>
                    <Pencil className="mr-1 h-3.5 w-3.5" />{t('common.edit')}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void setActive(w, !w.isActive) }}>
                    {busy === `active:${w.id}` ? <Spinner className="mr-1 h-3.5 w-3.5" /> : w.isActive ? <PowerOff className="mr-1 h-3.5 w-3.5" /> : <Power className="mr-1 h-3.5 w-3.5" />}
                    {w.isActive ? t('event_webhooks.turn_off') : t('event_webhooks.turn_on')}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void rotate(w) }}>
                    {busy === `rotate:${w.id}` ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <KeyRound className="mr-1 h-3.5 w-3.5" />}{t('event_webhooks.rotate')}
                  </Button>
                  {w.failed7d > 0 && (
                    <Button size="sm" variant="outline" disabled={busy !== null || !w.isActive} title={w.isActive ? undefined : t('event_webhooks.retry_inactive')} onClick={() => { void retry({ webhookId: w.id }, `retryall:${w.id}`) }}>
                      {busy === `retryall:${w.id}` ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <RefreshCcw className="mr-1 h-3.5 w-3.5" />}{t('event_webhooks.retry_failed')}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void remove(w) }} aria-label={t('common.delete')} title={t('common.delete')}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {result && (
                <Notice
                  tone={result.ok ? 'green' : 'red'}
                  message={result.ok
                    ? t('event_webhooks.test_ok', { status: result.statusCode ?? '' })
                    : t('event_webhooks.test_failed', { error: result.error ?? '' })}
                />
              )}
            </div>
          )
        })}
      </div>

      <div className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium text-gray-900 dark:text-gray-100">{t('event_webhooks.log_title')}</p>
            <p className="mt-1 max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('event_webhooks.log_hint')}</p>
          </div>
          {state.webhooks.length > 1 && (
            <SingleSelect
              label={t('event_webhooks.filter_label')}
              labelIcon={Webhook}
              value={filter}
              onChange={setFilter}
              options={[{ value: '', label: t('event_webhooks.filter_all') }, ...state.webhooks.map((w) => ({ value: w.id, label: w.name }))]}
            />
          )}
        </div>
        {state.deliveries.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('event_webhooks.log_empty')}</p>
        ) : (
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-white text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                <tr>
                  <th className="py-1 pr-3 font-medium">{t('event_webhooks.cols.when')}</th>
                  <th className="py-1 pr-3 font-medium">{t('event_webhooks.cols.webhook')}</th>
                  <th className="py-1 pr-3 font-medium">{t('event_webhooks.cols.event')}</th>
                  <th className="py-1 pr-3 font-medium">{t('event_webhooks.cols.status')}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t('event_webhooks.cols.attempts')}</th>
                  <th className="py-1 pr-3 font-medium">{t('event_webhooks.cols.answer')}</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody className="text-gray-800 dark:text-gray-200">
                {state.deliveries.map((d) => (
                  <DeliveryRow
                    key={d.id}
                    d={d}
                    webhookName={nameOf.get(d.webhookId) ?? ''}
                    eventLabel={eventLabel(d.eventType)}
                    payload={payloads[d.id]}
                    busy={busy}
                    onTogglePayload={() => { void togglePayload(d) }}
                    onRetry={() => { void retry({ deliveryId: d.id }, `retry:${d.id}`) }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function DeliveryRow({ d, webhookName, eventLabel, payload, busy, onTogglePayload, onRetry }: {
  d: DeliveryView
  webhookName: string
  eventLabel: string
  payload: string | undefined
  busy: string | null
  onTogglePayload: () => void
  onRetry: () => void
}) {
  const { t } = useTranslation()
  // A redirect's explanation is worth showing; any other status speaks for itself.
  const isRedirect = d.lastStatusCode != null && d.lastStatusCode >= 300 && d.lastStatusCode < 400
  const answer = d.lastStatusCode != null
    ? `HTTP ${d.lastStatusCode}${isRedirect && d.lastError ? ` · ${d.lastError}` : ''}`
    : d.lastError ?? '—'
  return (
    <>
      <tr className="border-t border-gray-100 align-top dark:border-gray-800">
        <td className="whitespace-nowrap py-1.5 pr-3">{formatDateTimeInTZ(d.createdAt)}</td>
        <td className="py-1.5 pr-3">{webhookName}</td>
        <td className="py-1.5 pr-3">{eventLabel}</td>
        <td className="py-1.5 pr-3"><StatusBadge d={d} /></td>
        <td className="py-1.5 pr-3 text-right">{d.attempts}</td>
        <td className="max-w-xs py-1.5 pr-3 text-gray-600 dark:text-gray-300">{answer}</td>
        <td className="whitespace-nowrap py-1.5 text-right">
          <button type="button" className="mr-2 inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400" onClick={onTogglePayload}>
            {payload !== undefined ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {payload !== undefined ? t('event_webhooks.hide_payload') : t('event_webhooks.view_payload')}
          </button>
          {d.status === 'failed' && d.eventType !== TEST_EVENT_TYPE && (
            <button type="button" disabled={busy !== null} className="inline-flex items-center gap-1 text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400" onClick={onRetry}>
              <RefreshCcw className="h-3 w-3" />{t('event_webhooks.retry')}
            </button>
          )}
        </td>
      </tr>
      {payload !== undefined && (
        <tr>
          <td colSpan={7} className="pb-2">
            <pre className="max-h-80 overflow-auto rounded-md bg-gray-50 p-3 font-mono text-[11px] text-gray-800 dark:bg-gray-950 dark:text-gray-200">{payload}</pre>
          </td>
        </tr>
      )}
    </>
  )
}

function StatusBadge({ d }: { d: DeliveryView }) {
  const { t } = useTranslation()
  if (d.status === 'delivered') {
    return <Badge variant="success" className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />{t('event_webhooks.status.delivered')}</Badge>
  }
  if (d.status === 'failed') {
    return <Badge variant="destructive" className="inline-flex items-center gap-1"><XCircle className="h-3 w-3" />{t('event_webhooks.status.failed')}</Badge>
  }
  return (
    <Badge variant="warning" className="inline-flex items-center gap-1" title={t('event_webhooks.next_try', { when: formatDateTimeInTZ(d.nextAttemptAt) })}>
      <Clock className="h-3 w-3" />{d.attempts > 0 ? t('event_webhooks.status.retrying') : t('event_webhooks.status.pending')}
    </Badge>
  )
}

function Notice({ tone, message }: { tone: 'red' | 'green'; message: string }) {
  const cls = tone === 'red'
    ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
    : 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300'
  const Icon = tone === 'red' ? AlertCircle : CheckCircle2
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${cls}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="break-words">{message}</span>
    </div>
  )
}
