import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Plus, Trash2, Save, X, Plug, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'

interface ApiKeyRow {
  id: string
  name: string
  keyPrefix: string
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
  scopes?: string[]
}

type Scope = 'rest:full' | 'mcp:read' | 'effort:read'

// Same JSON shape as Admin → Integrations → MCP Server's own snippets
// (McpServerConfig.tsx) — kept in sync deliberately so a screenshot from
// either page pastes into the same mcp.json shape.
function ClaudeConnectBlock({ token, showTitle = true }: { token: string; showTitle?: boolean }) {
  const { t } = useTranslation()
  const serverUrl = `${window.location.origin}/api/mcp`
  const snippet = JSON.stringify({
    mcpServers: {
      impactiq: {
        transport: 'http',
        url: serverUrl,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  }, null, 2)
  function copy(text: string) { void navigator.clipboard.writeText(text) }
  return (
    <div className="rounded-md border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950/30">
      {showTitle && (
        <p className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-indigo-800 dark:text-indigo-200">
          <Plug className="h-3.5 w-3.5" />
          {t('settings.api_keys.mcp_connect_title', 'Connect this key to Claude')}
        </p>
      )}
      <div className="mb-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-indigo-700 dark:text-indigo-300">{t('settings.api_keys.mcp_connect_desktop_label', 'Claude Desktop / Claude Code — mcp.json')}</p>
          <button onClick={() => copy(snippet)} className="rounded p-1 text-indigo-500 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-200"><Copy className="h-3.5 w-3.5" /></button>
        </div>
        <pre className="mt-1 overflow-x-auto rounded bg-white p-2 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-100">{snippet}</pre>
      </div>
      <div>
        <p className="text-xs font-medium text-indigo-700 dark:text-indigo-300">{t('settings.api_keys.mcp_connect_web_label', 'claude.ai web (Connectors)')}</p>
        <p className="mt-1 text-xs text-indigo-700 dark:text-indigo-300">
          {t('settings.api_keys.mcp_connect_web_hint', 'Settings → Connectors → Add custom connector. Name: anything recognizable. Remote MCP server URL:')}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <code className="flex-1 break-all rounded bg-white px-2 py-1 text-xs text-gray-900 dark:bg-gray-900 dark:text-gray-100">{serverUrl}</code>
          <button onClick={() => copy(serverUrl)} className="rounded p-1 text-indigo-500 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-200"><Copy className="h-3.5 w-3.5" /></button>
        </div>
        <p className="mt-2 text-[11px] text-indigo-600 dark:text-indigo-400">
          {t('settings.api_keys.mcp_connect_web_auth_caveat', "That dialog has no field for this key today — if it doesn't prompt you to authenticate after Continue, use Claude Desktop, Claude Code, or Cowork instead, which accept the key directly.")}
        </p>
      </div>
    </div>
  )
}

export function ApiKeysSection() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<ApiKeyRow[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [expiresInDays, setExpiresInDays] = useState<string>('365')
  const [scopes, setScopes] = useState<Scope[]>(['rest:full'])
  const [saving, setSaving] = useState(false)
  const [showKey, setShowKey] = useState<string | null>(null)
  const [showKeyScopes, setShowKeyScopes] = useState<Scope[]>([])
  const [mcpHelpOpen, setMcpHelpOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    const res = await api.get<ApiKeyRow[]>('/auth/api-keys')
    setRows(res.data ?? [])
  }
  useEffect(() => { void reload() }, [])

  async function submit() {
    setSaving(true); setError(null)
    const body: Record<string, unknown> = { name: name.trim() }
    const days = Number(expiresInDays.trim())
    if (Number.isFinite(days) && days > 0) body['expiresInDays'] = Math.floor(days)
    if (scopes.length > 0) body['scopes'] = scopes
    const res = await api.post<{ key: string; keyPrefix: string }>('/auth/api-keys', body)
    setSaving(false)
    if (res.error || !res.data) { setError(res.error ?? 'Failed'); return }
    setShowKey(res.data.key)
    setShowKeyScopes(scopes)
    setName(''); setExpiresInDays('365'); setScopes(['rest:full']); setCreating(false)
    await reload()
  }

  async function revoke(id: string, keyName: string) {
    if (!window.confirm(t('settings.api_keys.revoke_confirm', { name: keyName }))) return
    await api.delete(`/auth/api-keys/${id}`)
    await reload()
  }

  return (
    <div className="flex flex-col gap-3">
      {showKey && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
          <p className="mb-2 text-sm font-semibold text-amber-800 dark:text-amber-200">{t('settings.api_keys.show_once_title')}</p>
          <p className="mb-2 text-xs text-amber-700 dark:text-amber-300">{t('settings.api_keys.show_once_warning')}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-white p-2 text-xs text-gray-900 dark:bg-gray-900 dark:text-gray-100">{showKey}</code>
            <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(showKey) }}><Copy className="h-3 w-3" /></Button>
          </div>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setShowKey(null)}>{t('settings.api_keys.dismiss')}</Button>
        </div>
      )}
      {showKey && showKeyScopes.includes('mcp:read') && <ClaudeConnectBlock token={showKey} />}
      {!creating ? (
        <div>
          <Button size="sm" onClick={() => setCreating(true)}><Plus className="mr-1 h-3 w-3" />{t('settings.api_keys.create')}</Button>
        </div>
      ) : (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1"><Label>{t('settings.api_keys.name_label')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Read-only dashboard" /></div>
            <div className="flex flex-col gap-1"><Label>{t('settings.api_keys.expires_label')}</Label><Input type="number" min={1} value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} /></div>
          </div>
          {/* v1.145.0: scope picker. rest:full = classic full-access REST
              key. mcp:read = read-only access via the MCP server.
              v1.448.0: effort:read = hour totals per CRM Opportunity, the key
              CriteriaIQ stores to show SE effort on a project. */}
          <div className="mt-3 flex flex-col gap-1">
            <Label>{t('settings.api_keys.scopes_label', 'Scopes')}</Label>
            <div className="flex flex-wrap gap-3">
              {(['rest:full', 'mcp:read', 'effort:read'] as const).map((s) => (
                <label key={s} className="inline-flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s)}
                    onChange={(e) => setScopes((prev) => e.target.checked ? [...prev, s] : prev.filter((x) => x !== s))}
                    className="h-3.5 w-3.5"
                  />
                  <code className="rounded bg-gray-200 px-1 py-0.5 text-[10px] dark:bg-gray-700">{s}</code>
                  {s === 'rest:full' && <span className="text-[10px] text-gray-500">{t('settings.api_keys.scope_rest_full_hint', 'Full REST API access (legacy default)')}</span>}
                  {s === 'mcp:read' && <span className="text-[10px] text-gray-500">{t('settings.api_keys.scope_mcp_read_hint', 'Read-only access via MCP for LLM tools / n8n')}</span>}
                  {s === 'effort:read' && <span className="text-[10px] text-gray-500">{t('settings.api_keys.scope_effort_read_hint')}</span>}
                </label>
              ))}
            </div>
          </div>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={submit} disabled={saving || !name.trim()}>
              {saving ? <Spinner className="mr-1 h-3 w-3" /> : <Save className="mr-1 h-3.5 w-3.5" />}
              {t('common.save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              <X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
      {!rows ? <Spinner className="h-4 w-4" /> : rows.length === 0 ? (
        <p className="py-3 text-sm text-gray-500 dark:text-gray-400">{t('settings.api_keys.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-gray-500 dark:text-gray-400">
            <tr><th className="py-1">{t('settings.api_keys.col_name')}</th><th>{t('settings.api_keys.col_prefix')}</th><th>{t('settings.api_keys.col_scopes', 'Scopes')}</th><th>{t('settings.api_keys.col_last_used')}</th><th>{t('settings.api_keys.col_expires')}</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-gray-100 dark:border-gray-900">
                <td className="py-2">{r.name}</td>
                <td className="font-mono text-xs">{r.keyPrefix}…</td>
                <td>
                  {(r.scopes ?? ['rest:full']).map((s) => (
                    <code key={s} className="mr-1 rounded bg-gray-100 px-1 py-0.5 text-[10px] dark:bg-gray-800">{s}</code>
                  ))}
                </td>
                <td className="text-xs text-gray-500 dark:text-gray-400">{r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleDateString() : '—'}</td>
                <td className="text-xs text-gray-500 dark:text-gray-400">{r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : t('settings.api_keys.never')}</td>
                <td className="text-right"><button onClick={() => revoke(r.id, r.name)} className="rounded p-1 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="rounded-md border border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={() => setMcpHelpOpen((o) => !o)}
          aria-expanded={mcpHelpOpen}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
        >
          <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300">
            <Plug className="h-3.5 w-3.5 text-gray-500" />
            {t('settings.api_keys.mcp_connect_collapsed_title', 'Using an mcp:read key with Claude')}
          </span>
          {mcpHelpOpen ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
        </button>
        {mcpHelpOpen && (
          <div className="border-t border-gray-200 p-3 dark:border-gray-700">
            <ClaudeConnectBlock token="iqk_YOUR_MCP_READ_TOKEN" showTitle={false} />
          </div>
        )}
      </div>
    </div>
  )
}
