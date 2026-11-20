import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Power, PowerOff, KeyRound, ChevronDown, ChevronRight, Plug } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { McpActivity } from './McpActivity.js'

export function McpServerConfig() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  // Connection details collapse — collapsed by default so the MCP Activity
  // KPIs below are the focus once the server is configured.
  const [connOpen, setConnOpen] = useState(false)

  const serverUrl = `${window.location.origin}/api/mcp`

  async function reload() {
    const res = await api.get<{ enabled: boolean }>('/api/admin/mcp-config')
    setEnabled(res.data?.enabled ?? true)
  }
  useEffect(() => { void reload() }, [])

  async function toggle() {
    if (enabled === null) return
    setSaving(true)
    await api.patch('/api/admin/mcp-config', { enabled: !enabled })
    setSaving(false)
    void reload()
  }

  function copy(text: string) { void navigator.clipboard.writeText(text) }

  if (enabled === null) return <Spinner className="h-4 w-4" />

  const n8nSnippet = JSON.stringify({
    node: 'MCP Client Tool',
    serverUrl,
    headers: { Authorization: 'Bearer iqk_<your-mcp:read-token>' },
  }, null, 2)

  const claudeSnippet = JSON.stringify({
    mcpServers: {
      impactiq: {
        transport: 'http',
        url: serverUrl,
        headers: { Authorization: 'Bearer iqk_<your-mcp:read-token>' },
      },
    },
  }, null, 2)

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-semibold text-gray-800 dark:text-gray-100">{t('admin.mcp_server.status_label', 'MCP server')}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {enabled
                ? t('admin.mcp_server.status_on', 'Enabled — MCP clients with a mcp:read token can call read tools.')
                : t('admin.mcp_server.status_off', 'Disabled — every MCP call returns 503.')}
            </p>
          </div>
          <button
            onClick={toggle}
            disabled={saving}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${enabled ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300' : 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}
          >
            {enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
            {enabled ? t('admin.mcp_server.toggle_off', 'Turn off') : t('admin.mcp_server.toggle_on', 'Turn on')}
          </button>
        </div>
      </div>

      {/* Connection details — combined into one collapsible card, collapsed
          by default so the activity KPIs below lead once configured. */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        <button
          type="button"
          onClick={() => setConnOpen((o) => !o)}
          aria-expanded={connOpen}
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            <Plug className="h-4 w-4 text-gray-500" />
            {t('admin.mcp_server.connection_details', 'Connection details')}
          </span>
          {connOpen ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
        </button>
        {connOpen && (
          <div className="space-y-4 border-t border-gray-200 p-4 dark:border-gray-800">
            <div>
              <p className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">{t('admin.mcp_server.url_label', 'Server URL')}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-gray-100 px-2 py-1 text-xs text-gray-900 dark:bg-gray-800 dark:text-gray-100">{serverUrl}</code>
                <button onClick={() => copy(serverUrl)} className="rounded p-1 text-gray-500 hover:text-blue-600"><Copy className="h-4 w-4" /></button>
              </div>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {t('admin.mcp_server.url_hint', 'Streamable HTTP transport. Auth via Authorization: Bearer <mcp:read API key>.')}
              </p>
              <a href="/settings#api-keys" className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">
                <KeyRound className="h-3.5 w-3.5" />
                {t('admin.mcp_server.create_key_link', 'Create an mcp:read key in My Settings → API Keys')}
              </a>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">{t('admin.mcp_server.n8n_snippet', 'n8n MCP Client Tool config')}</p>
                <button onClick={() => copy(n8nSnippet)} className="rounded p-1 text-gray-500 hover:text-blue-600"><Copy className="h-4 w-4" /></button>
              </div>
              <pre className="mt-2 overflow-x-auto rounded bg-gray-50 p-2 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-100">{n8nSnippet}</pre>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">{t('admin.mcp_server.claude_snippet', 'Claude Desktop mcp.json')}</p>
                <button onClick={() => copy(claudeSnippet)} className="rounded p-1 text-gray-500 hover:text-blue-600"><Copy className="h-4 w-4" /></button>
              </div>
              <pre className="mt-2 overflow-x-auto rounded bg-gray-50 p-2 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-100">{claudeSnippet}</pre>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">{t('admin.mcp_server.web_connector_label', 'claude.ai web (Connectors)')}</p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('admin.mcp_server.web_connector_steps', 'Settings → Connectors → Add custom connector. Name: anything recognizable. Remote MCP server URL: the Server URL above.')}
              </p>
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                {t('admin.mcp_server.web_connector_auth_caveat', "That dialog has no field for a Bearer token today — if it doesn't prompt for authentication after Continue, an mcp:read key may not work there yet. Claude Desktop, Claude Code, and Cowork all accept the key directly via a custom header and are the reliable path in the meantime.")}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* MCP activity (KPIs + log) now lives here rather than a separate page. */}
      <McpActivity />
    </div>
  )
}
