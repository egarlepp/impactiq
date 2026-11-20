import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Power, PowerOff, Pencil, Save, X, Link2 } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Select } from '../ui/select.js'
import { Badge } from '../ui/badge.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { useCrmLabelContext, useCrmProvider } from '../../store/crmProvider.js'
import type { HubspotProjectObject } from '../../../shared/hubspot.js'

type MatchType = 'equals' | 'includes'
interface AttachField {
  id: string
  teamId: string
  crmObject: string
  fieldApi: string
  matchType: MatchType
  resolveUsers: boolean
  oppLinkField: string | null
  roleLabel: string | null
  isActive: boolean
}
interface SfObjectMeta { name: string; label: string }
interface LiveSfField { apiName: string; label: string }
interface Draft { crmObject: string; fieldApi: string; matchType: MatchType; oppLinkField: string; roleLabel: string }

const FALLBACK_OBJECTS = ['Opportunity', 'Evaluations__c']
const DEFAULT_LINK = 'Opportunity__c'
// HubSpot (phase 7b): Deal properties, or a Project object's properties
// rolled up onto its associated Deals (no link field: HubSpot associates).
const HUBSPOT_DEALS = 'deals'
const emptyDraft = (hubspot = false): Draft => ({ crmObject: hubspot ? HUBSPOT_DEALS : 'Opportunity', fieldApi: '', matchType: 'equals', oppLinkField: DEFAULT_LINK, roleLabel: '' })

export function AttachRateFieldsConfig({ teamId }: { teamId: string }) {
  const { t } = useTranslation()
  const crmProvider = useCrmProvider()
  const crmCtx = useCrmLabelContext()
  const hubspot = crmProvider === 'hubspot'
  const [rows, setRows] = useState<AttachField[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [objects, setObjects] = useState<string[]>(FALLBACK_OBJECTS)
  const [liveFields, setLiveFields] = useState<Record<string, LiveSfField[]>>({})
  const [add, setAdd] = useState<Draft>(emptyDraft())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [edit, setEdit] = useState<Draft>(emptyDraft())

  const load = () => {
    setLoading(true)
    api.get<AttachField[]>(`/api/admin/teams/${teamId}/attach-rate-fields`)
      .then((res) => setRows(res.data ?? []))
      .finally(() => setLoading(false))
  }
  useEffect(load, [teamId])

  const [projectObjects, setProjectObjects] = useState<HubspotProjectObject[]>([])
  useEffect(() => {
    if (!hubspot) return
    setAdd((d) => (d.crmObject === 'Opportunity' ? emptyDraft(true) : d))
    api.get<HubspotProjectObject[]>('/api/admin/hubspot/project-objects')
      .then((res) => setProjectObjects(res.data ?? []))
      .catch(() => { /* Deals only */ })
  }, [hubspot])

  useEffect(() => {
    if (hubspot) return
    api.get<SfObjectMeta[]>('/api/admin/sf/objects')
      .then((res) => {
        const names = (res.data ?? []).map((o) => o.name).filter(Boolean)
        if (names.length > 0) setObjects(Array.from(new Set([...FALLBACK_OBJECTS, ...names])))
      })
      .catch(() => { /* keep fallback */ })
  }, [hubspot])

  const loadLiveFields = (object: string) => {
    if (!object || liveFields[object]) return
    const url = hubspot
      ? `/api/admin/hubspot/properties?object=${encodeURIComponent(object)}`
      : `/api/admin/sf/fields?object=${encodeURIComponent(object)}`
    api.get<{ object: string; fields: LiveSfField[] }>(url)
      .then((res) => { if (res.data?.fields) setLiveFields((s) => ({ ...s, [object]: res.data!.fields })) })
      .catch(() => { /* datalist is optional */ })
  }
  useEffect(() => { loadLiveFields(add.crmObject) }, [add.crmObject, hubspot])

  const payload = (d: Draft) => ({
    crmObject: d.crmObject,
    fieldApi: d.fieldApi,
    matchType: d.matchType,
    oppLinkField: hubspot || d.crmObject.toLowerCase() === 'opportunity' ? null : (d.oppLinkField || DEFAULT_LINK),
    roleLabel: d.roleLabel.trim() || null,
  })

  const create = async () => {
    if (!/^[A-Za-z0-9_.]{1,80}$/.test(add.fieldApi)) return
    setSaving(true)
    await api.post(`/api/admin/teams/${teamId}/attach-rate-fields`, { ...payload(add), isActive: true })
    setAdd((d) => ({ ...d, fieldApi: '' }))
    setSaving(false)
    load()
  }
  const startEdit = (r: AttachField) => {
    setEditingId(r.id)
    setEdit({ crmObject: r.crmObject, fieldApi: r.fieldApi, matchType: r.matchType, oppLinkField: r.oppLinkField || DEFAULT_LINK, roleLabel: r.roleLabel ?? '' })
    loadLiveFields(r.crmObject)
  }
  const saveEdit = async (id: string) => {
    if (!/^[A-Za-z0-9_.]{1,80}$/.test(edit.fieldApi)) return
    setSaving(true)
    await api.patch(`/api/admin/teams/${teamId}/attach-rate-fields/${id}`, payload(edit))
    setEditingId(null)
    setSaving(false)
    load()
  }
  const toggle = async (r: AttachField) => {
    await api.patch(`/api/admin/teams/${teamId}/attach-rate-fields/${r.id}`, { isActive: !r.isActive })
    load()
  }
  const remove = async (id: string) => {
    await api.delete(`/api/admin/teams/${teamId}/attach-rate-fields/${id}`)
    load()
  }

  const hubspotObjectLabel = (o: string): string => {
    if (o === HUBSPOT_DEALS) return t('admin.sf_mappings.hubspot_objects.deals')
    const p = projectObjects.find((x) => x.objectTypeId === o)
    return !p || p.standard ? t('admin.sf_mappings.hubspot_objects.projects') : (p.label ?? o)
  }
  const objectOptions = hubspot
    ? [HUBSPOT_DEALS, ...projectObjects.map((p) => p.objectTypeId)].map((o) => ({ value: o, label: hubspotObjectLabel(o) }))
    : objects.map((o) => ({ value: o, label: o }))
  const objectLabel = (o: string) => (hubspot ? hubspotObjectLabel(o) : o)
  const fieldListId = (obj: string) => `attach-fields-${obj}`
  // Rows with no link field: the Opportunity itself, and anything on HubSpot.
  const isOpp = (obj: string) => hubspot || obj.toLowerCase() === 'opportunity'

  // Shared draft editor (used in the add card and inline edit rows).
  const draftFields = (d: Draft, set: (next: Draft) => void, compact = false) => (
    <>
      <div className="flex flex-col gap-1">
        <Label>{t('admin.attach_rate_fields.col_object', { context: crmCtx })}</Label>
        <Select value={d.crmObject} onChange={(e) => { const v = e.target.value; set({ ...d, crmObject: v }); loadLiveFields(v) }} className={compact ? 'w-40' : 'w-44'}>
          {objectOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label>{t('admin.attach_rate_fields.col_field', { context: crmCtx })}</Label>
        <Input value={d.fieldApi} onChange={(e) => set({ ...d, fieldApi: e.target.value })} list={fieldListId(d.crmObject)} placeholder={hubspot ? 'assigned_se' : 'Assigned_SE__c'} className="w-64 font-mono" />
      </div>
      <div className="flex flex-col gap-1">
        <Label>{t('admin.attach_rate_fields.col_match')}</Label>
        <Select value={d.matchType} onChange={(e) => set({ ...d, matchType: e.target.value as MatchType })} className="w-40">
          <option value="equals">{t('admin.attach_rate_fields.match_equals')}</option>
          <option value="includes">{t('admin.attach_rate_fields.match_includes')}</option>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label>{t('admin.attach_rate_fields.col_role')}</Label>
        <Input value={d.roleLabel} onChange={(e) => set({ ...d, roleLabel: e.target.value })} placeholder={t('admin.attach_rate_fields.role_placeholder')} className="w-44" />
      </div>
      {!isOpp(d.crmObject) && (
        <div className="flex flex-col gap-1">
          <Label>{t('admin.attach_rate_fields.link_field')}</Label>
          <Input value={d.oppLinkField} onChange={(e) => set({ ...d, oppLinkField: e.target.value })} placeholder={DEFAULT_LINK} className="w-48 font-mono" />
        </div>
      )}
    </>
  )

  if (loading) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>

  return (
    <div className="flex flex-col gap-6">
      {Object.entries(liveFields).map(([obj, fields]) => (
        <datalist key={obj} id={fieldListId(obj)}>
          {fields.map((f) => <option key={f.apiName} value={f.apiName}>{f.label}</option>)}
        </datalist>
      ))}

      <p className="text-sm text-gray-500 dark:text-gray-400">{t('admin.attach_rate_fields.description', { context: crmCtx })}</p>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr className="text-left text-gray-600 dark:text-gray-300">
              <th className="px-4 py-2 font-medium">{t('admin.attach_rate_fields.col_object', { context: crmCtx })}</th>
              <th className="px-4 py-2 font-medium">{t('admin.attach_rate_fields.col_field', { context: crmCtx })}</th>
              <th className="px-4 py-2 font-medium">{t('admin.attach_rate_fields.col_match')}</th>
              <th className="px-4 py-2 font-medium">{t('admin.attach_rate_fields.col_role')}</th>
              <th className="px-4 py-2 font-medium">{t('admin.attach_rate_fields.col_status')}</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400 dark:text-gray-500">{t('admin.attach_rate_fields.empty')}</td></tr>
            ) : rows.map((r) => {
              const editing = editingId === r.id
              if (editing) {
                return (
                  <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td colSpan={6} className="px-4 py-3">
                      <div className="flex flex-wrap items-end gap-3">
                        {draftFields(edit, setEdit, true)}
                        <Button variant="ghost" size="sm" onClick={() => saveEdit(r.id)} disabled={saving} title={t('admin.attach_rate_fields.save')}>
                          <Save className="h-4 w-4 text-green-600" /> {t('admin.attach_rate_fields.save')}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditingId(null)} title={t('admin.attach_rate_fields.cancel')}>
                          <X className="h-4 w-4" /> {t('admin.attach_rate_fields.cancel')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              }
              return (
                <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-300">
                    {objectLabel(r.crmObject)}
                    {!isOpp(r.crmObject) && <span className="ml-1 text-xs text-gray-400 dark:text-gray-500">→ {r.oppLinkField || DEFAULT_LINK}</span>}
                  </td>
                  <td className="px-4 py-2 font-mono text-gray-900 dark:text-gray-100">{r.fieldApi}</td>
                  <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{t(`admin.attach_rate_fields.match_${r.matchType}`)}</td>
                  <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{r.roleLabel || <span className="text-gray-400">—</span>}</td>
                  <td className="px-4 py-2">
                    {r.isActive
                      ? <Badge className="gap-1 bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"><Power className="h-3 w-3" />{t('admin.attach_rate_fields.active')}</Badge>
                      : <Badge className="gap-1 bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"><PowerOff className="h-3 w-3" />{t('admin.attach_rate_fields.inactive')}</Badge>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(r)} title={t('admin.attach_rate_fields.edit')}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="sm" onClick={() => toggle(r)} title={r.isActive ? t('admin.attach_rate_fields.disable') : t('admin.attach_rate_fields.enable')}>
                        {r.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => remove(r.id)} title={t('admin.attach_rate_fields.delete')}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <p className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-200">{t('admin.attach_rate_fields.add_title')}</p>
        <div className="flex flex-wrap items-end gap-3">
          {draftFields(add, setAdd)}
          <Button onClick={create} disabled={saving || !add.fieldApi}>
            <Plus className="mr-1 h-4 w-4" />{t('admin.attach_rate_fields.add')}
          </Button>
        </div>
        <p className="mt-2 flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500"><Link2 className="h-3 w-3" /> {t('admin.attach_rate_fields.field_hint', { context: crmCtx })}</p>
      </div>
    </div>
  )
}
