import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Plus, Trash2, Save, X, Pencil, Search, ChevronDown, ChevronRight, Download, Upload, AlertTriangle, CheckCircle2, EyeOff, Cloud, Database, Info, type LucideIcon } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Button } from '../ui/button.js'
import { Select } from '../ui/select.js'
import { Spinner } from '../ui/spinner.js'
import { Badge } from '../ui/badge.js'
import { cn } from '../../lib/utils.js'
import { TeamAssignmentPicker } from './TeamAssignmentPicker.js'
import { SfMappingValidation } from './SfMappingValidation.js'
import { useTeam } from '../../hooks/useTeam.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { useCrmProvider, useCrmViewTranslation } from '../../store/crmProvider.js'
import { CRM_DISPLAY_NAMES } from '../../../shared/crmProvider.js'
import { SF_SE_FILTER_APP_FIELD } from '../../../shared/salesforceSeFilter.js'
import {
  HUBSPOT_MAPPABLE_OBJECTS,
  hubspotAppFieldsFor,
  hubspotObjectTakesConstants,
  isHubspotMappingObject,
  isHubspotMappingTarget,
  isHubspotProjectObject,
  type HubspotProjectObject,
} from '../../../shared/hubspot.js'

interface SfFieldMapping {
  id: string
  appField: string
  crmFieldApi: string
  crmObject: string
  direction: 'read' | 'write' | 'read_write'
  referenceTo: string | null
  isActive: boolean
  constantValue: string | null
  teamIds: string[]
  // v1.138.0: when true, refreshOppSnapshots pulls this field on each
  // nightly run and stamps it onto the linked activity snapshot.
  backgroundRefresh?: boolean
  // v1.140.0: refresh-only mappings — pulled from SF nightly, never
  // written back, and skipped by the read-into-form path. Used for
  // Opportunity metadata dashboards need but the app shouldn't mutate.
  refreshOnlyForReports?: boolean
}

interface SfObjectMeta {
  name: string
  label: string
  queryable: boolean
  createable: boolean
  updateable: boolean
  custom: boolean
}

// App-side fields available on an activity. Value is what the writeback
// looks up; label is human-friendly. `_constant` is the sentinel that flips
// the row into constant-value mode.
const APP_FIELD_OPTIONS: { value: string; label: string; hint?: string }[] = [
  { value: 'title', label: 'Activity Title', hint: 'title' },
  { value: 'activity_type', label: 'Activity Type', hint: 'activity_type' },
  { value: 'startdatetime', label: 'Start Datetime', hint: 'startdatetime' },
  { value: 'enddatetime', label: 'End Datetime', hint: 'enddatetime' },
  { value: 'effort_hours', label: 'Effort (Hours → Minutes)', hint: 'effort_hours' },
  { value: 'description', label: 'Event Description', hint: 'description' },
  { value: 'notes', label: 'Notes (app-only)', hint: 'notes' },
  { value: 'location', label: 'Location', hint: 'location' },
  { value: 'location_mode', label: 'Location Mode (Remote/Onsite)', hint: 'location_mode' },
  { value: 'meeting_owner', label: 'Meeting Owner', hint: 'meeting_owner' },
  { value: 'attendees', label: 'Attendees', hint: 'attendees' },
  { value: 'crm_what_id', label: 'Opportunity / Account Id', hint: 'crm_what_id' },
  { value: 'user_id', label: 'Owner (ImpactIQ user → CRM user)', hint: 'user_id' },
  { value: 'account_name__c', label: 'Account Name', hint: 'account_name__c' },
  { value: 'account_owner', label: 'Account Owner', hint: 'account_owner' },
  { value: 'account_owner_manager', label: 'Account Owner Manager', hint: 'account_owner_manager' },
  { value: 'assigned_to_name__c', label: 'Assigned To', hint: 'assigned_to_name__c' },
  { value: 'created_date__c', label: 'Created Date', hint: 'created_date__c' },
  { value: 'acv', label: 'ACV (Opportunity → Total_Acv__c)', hint: 'acv' },
  // v1.297.0: the Assigned Oppty SE picker on the activity edit drawer
  // (PATCH /opportunities/:id/assigned-se) previously always hardcoded
  // Assigned_SE__c regardless of what this mapping table said — this app
  // field is the actual, admin-configurable write target for that picker.
  // Distinct from account_owner-style read mappings on purpose: unlike a
  // User-lookup relationship path (e.g. Assigned_SE__r.Name, which is
  // read-only), this must resolve to a real writable Picklist/Text field
  // on Opportunity. Inert until mapped — falls back to the canonical
  // Assigned_SE__c when no active write/read_write row exists, same
  // convention as eval_engineer_notes/eval_primary_engineer below.
  { value: 'assigned_se_write', label: 'Assigned SE — Write Target (Opportunity)', hint: 'assigned_se_write' },
  // v1.474.0: Opportunity fields that name the people working a deal. The
  // default Opportunity search lists the user's own Opportunities plus any
  // where they're in one of these (several rows allowed). Label comes from
  // i18n in appFieldOptionsFor().
  { value: SF_SE_FILTER_APP_FIELD, label: SF_SE_FILTER_APP_FIELD, hint: SF_SE_FILTER_APP_FIELD },
  // v1.150.0: Evaluation ("Project") snapshot fields (migration 0090).
  // These let the admin see/re-map the Project panel's fields; the row
  // previously showed the raw key with the dropdown stuck on "—".
  { value: 'eval_name', label: 'Project Name', hint: 'eval_name' },
  { value: 'eval_status', label: 'Project Status', hint: 'eval_status' },
  { value: 'eval_stage', label: 'Project Stage', hint: 'eval_stage' },
  { value: 'eval_type', label: 'Project Type', hint: 'eval_type' },
  { value: 'eval_start_date', label: 'Project Start Date', hint: 'eval_start_date' },
  { value: 'eval_end_date', label: 'Project End Date', hint: 'eval_end_date' },
  { value: 'eval_primary_engineer', label: 'Project Primary Engineer', hint: 'eval_primary_engineer' },
  // v1.254.0: prepend-update fields (dated note posted above existing
  // content, history preserved) — see the Project panel's Situation/Next
  // Steps block and the activity Notes checkbox. Direction must be
  // write/read_write; a Long Text Area / Rich Text Area / Text field.
  { value: 'eval_engineer_notes', label: 'Project Engineer Notes', hint: 'eval_engineer_notes' },
  { value: 'eval_next_steps', label: 'Project Situation / Next Steps', hint: 'eval_next_steps' },
  // v1.293.0: Total Bookings breakdown — read/refresh-only, backs the
  // Opportunity Info panel's expandable business-breakdown section on the
  // activity form (live SF read via GET /api/salesforce/preview/Opportunity/:id,
  // never written back). Mark refreshOnlyForReports so collectExtraSelect()
  // includes them in that live read — see refreshOppSnapshots.ts.
  { value: 'opp_new_business_acv', label: 'New Business ACV (Opportunity)', hint: 'opp_new_business_acv' },
  { value: 'opp_new_business_tcv', label: 'New Business TCV (Opportunity)', hint: 'opp_new_business_tcv' },
  { value: 'opp_renewal_acv', label: 'Renewals ACV (Opportunity)', hint: 'opp_renewal_acv' },
  { value: 'opp_renewal_tcv', label: 'Renewals TCV (Opportunity)', hint: 'opp_renewal_tcv' },
  // v1.337.0: Support-ticket attachment (Activity Types → Ticket picker
  // Extra). All read-only — none of these feed buildSfRecord()'s write
  // payload; attached tickets live ImpactIQ-side only
  // (activity_crm_tickets). ticket_account is the lookup field on the
  // ticket object that references Account, used to scope the picker's
  // default (non-Open-Search) view.
  { value: 'ticket_number', label: 'Ticket — Number', hint: 'ticket_number' },
  { value: 'ticket_subject', label: 'Ticket — Subject', hint: 'ticket_subject' },
  { value: 'ticket_date_opened', label: 'Ticket — Date Opened', hint: 'ticket_date_opened' },
  { value: 'ticket_status', label: 'Ticket — Status', hint: 'ticket_status' },
  { value: 'ticket_contact', label: 'Ticket — Contact', hint: 'ticket_contact' },
  { value: 'ticket_description', label: 'Ticket — Description', hint: 'ticket_description' },
  { value: 'ticket_platform', label: 'Ticket — Platform', hint: 'ticket_platform' },
  { value: 'ticket_owner', label: 'Ticket — Owner', hint: 'ticket_owner' },
  { value: 'ticket_account', label: 'Ticket — Account Lookup', hint: 'ticket_account' },
  { value: '_constant', label: '(Constant value)', hint: 'writes a fixed value regardless of the app field' },
]

const KNOWN_EVENT_FIELDS = [
  'Subject', 'ActivityDateTime', 'DurationInMinutes', 'EndDateTime',
  'Description', 'WhatId', 'WhoId', 'OwnerId', 'Type', 'Location',
  'IsAllDayEvent', 'ShowAs', 'IsPrivate', 'ReminderDateTime',
  'IsReminderSet', 'ActivityDate', 'IsArchived', 'IsGroupEvent',
]
const KNOWN_TASK_FIELDS = [
  'Subject', 'ActivityDate', 'Status', 'Priority', 'Description',
  'WhatId', 'WhoId', 'OwnerId', 'Type', 'IsHighPriority',
  'IsClosed', 'IsArchived', 'CompletedDateTime', 'ReminderDateTime',
  'IsReminderSet',
]

interface LiveSfField {
  apiName: string
  label: string
  type: string
  isCustom: boolean
  referenceTo?: string[]
  // HubSpot properties (GET /api/admin/hubspot/properties) carry their
  // options and a read-only flag; Salesforce describe rows carry options too.
  picklistValues?: Array<{ value: string; label: string }>
  readOnly?: boolean
}

// v1.299.0: Export / Import — mirrors the server's SfFieldMappingExportRow /
// SfFieldMappingExportDocument shapes in routes/admin.ts exactly, since the
// export file IS the import file (round-trip, not two separate formats).
interface SfMappingImportRow {
  appField: string
  crmFieldApi: string
  crmObject: string
  direction: 'read' | 'write' | 'read_write'
  referenceTo: string | null
  isActive: boolean
  constantValue: string | null
  backgroundRefresh?: boolean
  refreshOnlyForReports?: boolean
  teamSlugs?: string[]
  updatedByEmail?: string | null
  updatedAt?: string | null
}
interface SfMappingImportDocument {
  formatVersion: 1
  exportedAt: string
  exportedByEmail?: string | null
  sourceTeamSlug?: string
  sourceTeamName?: string
  mappings: SfMappingImportRow[]
}
interface SfMappingImportDiffRow {
  appField: string
  crmObject: string
  changes?: Array<{ field: string; from: unknown; to: unknown }>
  unresolvedTeamSlugs?: string[]
}
interface SfMappingImportDiff {
  toCreate: SfMappingImportDiffRow[]
  toUpdate: SfMappingImportDiffRow[]
  unchanged: SfMappingImportDiffRow[]
  notInFile: SfMappingImportDiffRow[]
}

interface AddFormState {
  crmObject: string
  appField: string
  crmFieldApi: string
  direction: 'read' | 'write' | 'read_write'
  constantValue: string
  teamIds: string[]
  isActive: boolean
  backgroundRefresh: boolean
  refreshOnlyForReports: boolean
}

type MappableCrm = 'salesforce' | 'hubspot'
const MAPPABLE_CRMS: { id: MappableCrm; icon: LucideIcon }[] = [
  { id: 'salesforce', icon: Cloud },
  { id: 'hubspot', icon: Database },
]

export function SfFieldMappings({ teamId }: { teamId: string }) {
  const { teams } = useTeam()
  const { user } = useCurrentUser()
  const isAppAdmin = !!user?.isAppAdmin
  const teamNameById = new Map(teams.map((tm) => [tm.id, tm.name]))
  // Each CRM keeps its own mappings (crm_object 'Event', 'Opportunity', ... for
  // Salesforce; 'meetings', 'deals', ... for HubSpot). The toggle picks which
  // CRM's rows to view, check and add; it starts on the active CRM, and the
  // other CRM's rows stay stored and exported. Wording follows the toggle.
  const activeCrm = useCrmProvider()
  const [pickedCrm, setPickedCrm] = useState<MappableCrm | null>(null)
  const viewCrm: MappableCrm = pickedCrm ?? (activeCrm === 'hubspot' ? 'hubspot' : 'salesforce')
  const isHubspot = viewCrm === 'hubspot'
  const { t, crmCtx } = useCrmViewTranslation(viewCrm)
  const defaultObject = isHubspot ? 'meetings' : 'Event'
  const emptyForm: AddFormState = { crmObject: defaultObject, appField: '', crmFieldApi: '', direction: 'read_write', constantValue: '', teamIds: [teamId], isActive: true, backgroundRefresh: false, refreshOnlyForReports: false }
  const [mappings, setMappings] = useState<SfFieldMapping[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Record<string, string>>({})
  const [editingRowId, setEditingRowId] = useState<string | null>(null)
  const [rowEdit, setRowEdit] = useState<{ crmObject: string; appField: string; crmFieldApi: string; direction: 'read' | 'write' | 'read_write'; constantValue: string; isActive: boolean; backgroundRefresh: boolean; refreshOnlyForReports: boolean }>({ crmObject: 'Event', appField: '', crmFieldApi: '', direction: 'read_write', constantValue: '', isActive: true, backgroundRefresh: false, refreshOnlyForReports: false })
  const [sfObjects, setSfObjects] = useState<SfObjectMeta[]>([])
  const [sfObjectsLoading, setSfObjectsLoading] = useState(false)
  const [sfObjectsError, setSfObjectsError] = useState<string | null>(null)
  // v1.111.0: group mappings by SF object with collapsible sections.
  // Track open/closed per-object; default = only the first (top) group
  // expanded, rest collapsed. Uses a set so toggle is O(1) and empty
  // state = "all collapsed except first" via the isGroupOpen helper.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  // HubSpot Project objects (phase 6b): the standard Projects object and
  // any custom object, offered as mapping targets for the eval_* fields.
  const [projectObjects, setProjectObjects] = useState<HubspotProjectObject[]>([])
  useEffect(() => {
    if (!isHubspot) return
    let cancelled = false
    void api.get<HubspotProjectObject[]>('/api/admin/hubspot/project-objects').then((res) => {
      if (!cancelled) setProjectObjects(res.data ?? [])
    })
    return () => { cancelled = true }
  }, [isHubspot])
  function toggleGroup(obj: string) {
    setOpenGroups((prev) => ({ ...prev, [obj]: prev[obj] === undefined ? false : !prev[obj] }))
  }

  // The app fields this object's mappings can feed. HubSpot objects offer
  // only what ImpactIQ reads or writes there (src/shared/hubspot.ts).
  function appFieldOptionsFor(object: string): { value: string; label: string; hint?: string }[] {
    if (!isHubspotMappingTarget(object)) {
      return APP_FIELD_OPTIONS.map((o) => (o.value === SF_SE_FILTER_APP_FIELD ? { ...o, label: t('admin.sf_mappings.opp_se_filter_label') } : o))
    }
    const opts = hubspotAppFieldsFor(object).map((v) => ({ value: v, label: t(`admin.sf_mappings.hubspot_app_fields.${v}`), hint: v }))
    if (isHubspotMappingObject(object) && hubspotObjectTakesConstants(object)) opts.push({ value: '_constant', label: t('admin.sf_mappings.hubspot_app_fields._constant'), hint: '_constant' })
    return opts
  }
  function appFieldLabel(object: string, appField: string): string {
    return appFieldOptionsFor(object).find((o) => o.value === appField)?.label ?? appField
  }

  function openRowEdit(m: SfFieldMapping) {
    setEditingRowId(m.id)
    setRowEdit({ crmObject: m.crmObject, appField: m.appField, crmFieldApi: m.crmFieldApi, direction: m.direction, constantValue: m.constantValue ?? '', isActive: m.isActive, backgroundRefresh: !!m.backgroundRefresh, refreshOnlyForReports: !!m.refreshOnlyForReports })
    void loadLiveFields(m.crmObject)
    void loadSfObjects()
  }

  async function saveRowEdit(m: SfFieldMapping) {
    // Preserve `constantValue` on any mapping that already had one
    // (legacy rows like activity_status_completed use a non-_constant
    // appField but still write a fixed SF value on save). New rows can
    // opt in by selecting the "(Constant value)" app field.
    const isConstant = rowEdit.appField === '_constant' || rowEdit.constantValue.trim().length > 0
    if (rowEdit.appField === '_constant' && !rowEdit.constantValue.trim()) return
    setSaving(m.id)
    const res = await api.patch(`/api/admin/teams/${teamId}/sf-field-mappings/${m.id}`, {
      crmObject: rowEdit.crmObject,
      appField: rowEdit.appField.trim(),
      crmFieldApi: rowEdit.crmFieldApi.trim(),
      direction: rowEdit.direction,
      constantValue: isConstant ? rowEdit.constantValue.trim() : null,
      isActive: rowEdit.isActive,
      backgroundRefresh: rowEdit.backgroundRefresh,
      refreshOnlyForReports: rowEdit.refreshOnlyForReports,
    })
    setSaving(null)
    if (res.error) return
    setEditingRowId(null)
    await reload()
  }
  const [saving, setSaving] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [form, setForm] = useState<AddFormState>(emptyForm)
  const [liveFields, setLiveFields] = useState<Record<string, LiveSfField[]>>({ Event: [], Task: [] })
  const [liveFetchError, setLiveFetchError] = useState<string | null>(null)
  const [liveLoading, setLiveLoading] = useState<Record<string, boolean>>({ Event: false, Task: false })

  // v1.299.0: Export / Import.
  const [exporting, setExporting] = useState(false)
  const [importDoc, setImportDoc] = useState<SfMappingImportDocument | null>(null)
  const [importDiff, setImportDiff] = useState<SfMappingImportDiff | null>(null)
  const [importPreviewLoading, setImportPreviewLoading] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importApplying, setImportApplying] = useState(false)
  const [importResult, setImportResult] = useState<{ created: number; updated: number; skipped: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function reload() {
    setLoading(true)
    const res = await api.get<SfFieldMapping[]>(`/api/admin/teams/${teamId}/sf-field-mappings`)
    setMappings(res.data ?? [])
    setLoading(false)
  }

  // v1.299.0: Export — downloads this team's mappings as a JSON file that
  // can be re-imported (here or into a different install) via the button
  // below. Team assignment is exported as slugs, not raw UUIDs.
  async function handleExport() {
    setExporting(true)
    const res = await api.get<SfMappingImportDocument>(`/api/admin/teams/${teamId}/sf-field-mappings/export`)
    setExporting(false)
    if (!res.data) return
    const slug = res.data.sourceTeamSlug ?? 'team'
    const date = new Date().toISOString().slice(0, 10)
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sf-field-mappings-${slug}-${date}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  // Reads the picked file, then asks the server to diff it against this
  // team's CURRENT live mappings — never applies blind. The diff is what
  // answers "has anything changed since this was exported."
  async function handleImportFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImportError(null)
    setImportResult(null)
    setImportDiff(null)
    setImportDoc(null)
    let parsed: SfMappingImportDocument
    try {
      const text = await file.text()
      parsed = JSON.parse(text) as SfMappingImportDocument
    } catch {
      setImportError(t('admin.sf_mappings.import_invalid_file', 'That file is not valid JSON.'))
      return
    }
    if (parsed.formatVersion !== 1 || !Array.isArray(parsed.mappings)) {
      setImportError(t('admin.sf_mappings.import_invalid_format', 'That file is not a recognized SF Field Mappings export.'))
      return
    }
    setImportPreviewLoading(true)
    const res = await api.post<SfMappingImportDiff>(`/api/admin/teams/${teamId}/sf-field-mappings/import/preview`, { document: parsed })
    setImportPreviewLoading(false)
    if (res.error || !res.data) {
      setImportError(res.error ?? t('admin.sf_mappings.import_preview_failed', 'Could not preview this import.'))
      return
    }
    setImportDoc(parsed)
    setImportDiff(res.data)
  }

  async function applyImport() {
    if (!importDoc) return
    setImportApplying(true)
    const res = await api.post<{ created: number; updated: number; skipped: number }>(`/api/admin/teams/${teamId}/sf-field-mappings/import/apply`, { document: importDoc })
    setImportApplying(false)
    if (res.error || !res.data) {
      setImportError(res.error ?? t('admin.sf_mappings.import_apply_failed', 'Import failed to apply.'))
      return
    }
    setImportResult(res.data)
    setImportDiff(null)
    setImportDoc(null)
    await reload()
  }

  function closeImportModal() {
    setImportDoc(null)
    setImportDiff(null)
    setImportError(null)
    setImportResult(null)
  }

  async function loadLiveFields(object: string) {
    if ((liveFields[object]?.length ?? 0) > 0 || liveLoading[object]) return
    setLiveLoading((s) => ({ ...s, [object]: true }))
    const url = isHubspotMappingTarget(object)
      ? `/api/admin/hubspot/properties?object=${encodeURIComponent(object)}`
      : `/api/admin/sf/fields?object=${encodeURIComponent(object)}`
    const res = await api.get<{ object: string; fields: LiveSfField[] }>(url)
    if (res.data) {
      setLiveFields((s) => ({ ...s, [object]: res.data!.fields }))
      setLiveFetchError(null)
    } else if (res.error) {
      setLiveFetchError(res.error)
    }
    setLiveLoading((s) => ({ ...s, [object]: false }))
  }

  async function loadSfObjects() {
    if (isHubspot || sfObjects.length > 0 || sfObjectsLoading) return
    setSfObjectsLoading(true)
    setSfObjectsError(null)
    const res = await api.get<SfObjectMeta[]>('/api/admin/sf/objects')
    if (res.data) setSfObjects(res.data)
    else if (res.error) setSfObjectsError(res.error)
    setSfObjectsLoading(false)
  }

  useEffect(() => { void reload() }, [teamId])
  // The CRM is known a moment after mount; start the add form on its
  // default object.
  useEffect(() => { setForm((f) => ({ ...f, crmObject: defaultObject, appField: '', crmFieldApi: '', constantValue: '' })) }, [defaultObject])
  useEffect(() => {
    if (adding) {
      void loadSfObjects()
      void loadLiveFields(form.crmObject)
    }
  }, [adding, form.crmObject])

  async function save(id: string) {
    const crmFieldApi = editing[id]
    if (!crmFieldApi) return
    setSaving(id)
    await api.patch(`/api/admin/teams/${teamId}/sf-field-mappings/${id}`, { crmFieldApi })
    setEditing((prev) => { const next = { ...prev }; delete next[id]; return next })
    setSaving(null)
    await reload()
  }

  async function toggleActive(m: SfFieldMapping) {
    setSaving(m.id + '_toggle')
    await api.patch(`/api/admin/teams/${teamId}/sf-field-mappings/${m.id}`, { isActive: !m.isActive })
    setSaving(null)
    await reload()
  }

  async function remove(m: SfFieldMapping) {
    if (!window.confirm(t('admin.sf_mappings.delete_confirm', { field: m.appField }))) return
    setSaving(m.id + '_del')
    await api.delete(`/api/admin/teams/${teamId}/sf-field-mappings/${m.id}`)
    setSaving(null)
    await reload()
  }

  async function saveTeamIds(m: SfFieldMapping, teamIds: string[]) {
    setSaving(m.id + '_teams')
    await api.patch(`/api/admin/teams/${teamId}/sf-field-mappings/${m.id}`, { teamIds })
    setSaving(null)
    await reload()
  }

  async function submitAdd() {
    if (!form.appField.trim() || !form.crmFieldApi.trim()) return
    const isConstant = form.appField === '_constant' || form.constantValue.trim().length > 0
    if (form.appField === '_constant' && !form.constantValue.trim()) return
    setAddError(null)
    setSaving('add')
    // Ensure at least the current team is in the assignment payload so admin
    // users who never touched the picker still create a scoped mapping row.
    const teamIdsToSend = form.teamIds.length > 0 ? form.teamIds : [teamId]
    // Attach referenceTo from live describe metadata so the UI can render the
    // target hint next to lookup fields — persisted rather than re-derived so
    // dashboards can consume it without another describe round-trip.
    const liveList = liveFields[form.crmObject] ?? []
    const chosen = liveList.find((f) => f.apiName === form.crmFieldApi.trim())
    const referenceTo = chosen && Array.isArray(chosen.referenceTo) && chosen.referenceTo.length > 0
      ? chosen.referenceTo[0]!
      : null
    const res = await api.post<SfFieldMapping>(`/api/admin/teams/${teamId}/sf-field-mappings`, {
      appField: form.appField.trim(),
      crmFieldApi: form.crmFieldApi.trim(),
      crmObject: form.crmObject,
      direction: form.direction,
      referenceTo,
      constantValue: isConstant ? form.constantValue.trim() : null,
      teamIds: teamIdsToSend,
      isActive: form.isActive,
      backgroundRefresh: form.backgroundRefresh,
      refreshOnlyForReports: form.refreshOnlyForReports,
    })
    setSaving(null)
    if (res.error) {
      setAddError(res.error)
      return
    }
    if (res.data) {
      setForm(emptyForm)
      setAdding(false)
      await reload()
    }
  }

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>

  const datalistId = `sf-fields-${form.crmObject}`
  const live = liveFields[form.crmObject] ?? []
  const usingLive = live.length > 0
  const fallback = form.crmObject === 'Event' ? KNOWN_EVENT_FIELDS
    : form.crmObject === 'Task' ? KNOWN_TASK_FIELDS
    : [] as string[]
  const fieldOptions = usingLive
    ? live.map((f) => ({ value: f.apiName, label: `${f.label} (${f.apiName})` }))
    : fallback.map((name) => ({ value: name, label: name }))
  // Row column widths — keep the total on one line at the ~1200px content width
  // used by Admin pages. Admin variant adds a Scope column.
  // v1.139.0: SF API column narrowed to make room for the Refresh chip;
  // Status column widened so Active + Refresh pills fit inline.
  // v1.151.0: SF Object column widened 70px → 130px so longer custom
  // object names (e.g. "Evaluations__c") aren't cut off / overlapping.
  const visibleMappings = mappings.filter((m) => isHubspotMappingTarget(m.crmObject) === isHubspot)
  const hiddenCount = mappings.length - visibleMappings.length
  const gridCols = isAppAdmin
    ? 'grid-cols-[130px_minmax(150px,1fr)_minmax(170px,1.1fr)_120px_210px_100px]'
    : 'grid-cols-[130px_minmax(150px,1fr)_minmax(170px,1.1fr)_210px_100px]'

  return (
    <div className="flex flex-col gap-4">
      {/* v1.219.0: pre-flight check sits above the table, because the whole
          point is to run it before trusting what the table says. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-300" title={t('admin.sf_mappings.crm_toggle_hint')}>{t('admin.sf_mappings.crm_toggle_label')}</span>
        <div className="inline-flex overflow-hidden rounded-md border border-gray-200 dark:border-gray-700" role="group" aria-label={t('admin.sf_mappings.crm_toggle_label')}>
          {MAPPABLE_CRMS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={viewCrm === id}
              onClick={() => { setPickedCrm(id); setAdding(false); setEditingRowId(null) }}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium',
                viewCrm === id
                  ? 'bg-blue-600 text-white dark:bg-blue-500 dark:text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {CRM_DISPLAY_NAMES[id].name}
              {activeCrm === id && <span className="rounded bg-white/20 px-1 text-[10px] dark:bg-black/20">{t('admin.sf_mappings.crm_toggle_active')}</span>}
            </button>
          ))}
        </div>
      </div>
      {activeCrm !== viewCrm && (
        <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{activeCrm === 'none'
            ? t('admin.sf_mappings.inactive_view_none')
            : t('admin.sf_mappings.inactive_view', { active: CRM_DISPLAY_NAMES[activeCrm].name })}</span>
        </p>
      )}
      <SfMappingValidation key={viewCrm} teamId={teamId} crm={viewCrm} />
      {!isHubspot && !loading && !visibleMappings.some((m) => m.appField === SF_SE_FILTER_APP_FIELD && m.isActive) && (
        <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex flex-col gap-1">
            <span className="font-medium">{t('admin.sf_mappings.se_filter_hint_title')}</span>
            <span>{t('admin.sf_mappings.se_filter_hint_body')}</span>
            <span>{t('admin.sf_mappings.se_filter_hint_create')}</span>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <div className={cn('mb-2 grid gap-3 px-3 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500', gridCols)}>
          <span>{t('admin.sf_mappings.sf_object', { context: crmCtx })}</span>
          <span>{t('admin.sf_mappings.app_field')}</span>
          <span>{t('admin.sf_mappings.sf_api_field', { context: crmCtx })}</span>
          {isAppAdmin && <span>{t('admin.activity_types.scope')}</span>}
          <span>{t('admin.sf_mappings.status')}</span>
          <span></span>
        </div>
        {(() => {
          // v1.111.0: group mappings by crmObject, preserve insertion
          // order (server already sorts sensibly). First group defaults
          // to expanded, subsequent groups collapsed until clicked.
          const groups: { obj: string; rows: typeof mappings }[] = []
          const byObj = new Map<string, typeof mappings>()
          for (const m of visibleMappings) {
            if (!byObj.has(m.crmObject)) {
              const arr: typeof mappings = []
              byObj.set(m.crmObject, arr)
              groups.push({ obj: m.crmObject, rows: arr })
            }
            byObj.get(m.crmObject)!.push(m)
          }
          const firstObj = groups[0]?.obj
          const isOpen = (obj: string) => openGroups[obj] ?? (obj === firstObj)
          return groups.map((g) => (
            <div key={g.obj} className="mb-3 last:mb-0">
              <button
                type="button"
                onClick={() => toggleGroup(g.obj)}
                className="mb-1 flex w-full items-center justify-between gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-left hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800/50 dark:hover:bg-gray-800"
              >
                <div className="flex items-center gap-2">
                  {isOpen(g.obj)
                    ? <ChevronDown className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                    : <ChevronRight className="h-4 w-4 text-gray-500 dark:text-gray-400" />}
                  <span className="font-mono text-xs font-semibold text-gray-700 dark:text-gray-200">{g.obj}</span>
                  {isHubspot && isHubspotProjectObject(g.obj) && (
                    <span className="text-xs font-medium text-gray-700 dark:text-gray-200">{projectObjectName(g.obj, projectObjects, t)}</span>
                  )}
                  <span className="text-[11px] text-gray-500 dark:text-gray-400">
                    {t('admin.sf_mappings.group_count', '{{count}} field(s)', { count: g.rows.length })}
                  </span>
                </div>
              </button>
              {isOpen(g.obj) && (
                <div className="flex flex-col gap-1">
                  {g.rows.map((m) => (
          <div key={m.id}>
          <div className={cn('grid items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900', gridCols)}>
            <div className="flex min-w-0 flex-col">
              <span className="break-all font-mono text-xs text-gray-500 dark:text-gray-400">{m.crmObject}</span>
              <Badge
                variant={m.direction === 'read' ? 'secondary' : m.direction === 'write' ? 'outline' : 'default'}
                className="mt-0.5 w-fit text-[9px] uppercase tracking-wide"
                title={t(`admin.sf_mappings.direction_${m.direction}`)}
              >
                {m.direction === 'read' ? 'R' : m.direction === 'write' ? 'W' : 'R/W'}
              </Badge>
              {m.referenceTo && (
                <span className="text-[9px] text-gray-400 dark:text-gray-500" title={t('admin.sf_mappings.reference_to_hint', 'Salesforce lookup — resolves to a record in this SObject')}>
                  → {m.referenceTo}
                </span>
              )}
            </div>
            {/* App Field → label, stays on one line */}
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <span className="truncate font-medium text-gray-700 dark:text-gray-200">
                {appFieldLabel(m.crmObject, m.appField)}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-gray-400 dark:text-gray-500">{m.appField} →</span>
            </div>
            {/* SF API Field — wider column that keeps the constant chip on
                the same row as the API name. */}
            <div className="flex min-w-0 flex-nowrap items-center gap-2">
              <span className="truncate rounded border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200" title={m.crmFieldApi}>
                {m.crmFieldApi}
              </span>
              {m.constantValue !== null && (
                <Badge variant="secondary" className="shrink-0 whitespace-nowrap text-[10px]" title={t('admin.sf_mappings.constant_hint', { context: crmCtx })}>
                  = {m.constantValue}
                </Badge>
              )}
            </div>
            {isAppAdmin && (
              <div className="flex flex-wrap gap-1">
                {m.teamIds.length === 0 ? (
                  <span className="text-[10px] text-amber-500 dark:text-amber-400">{t('admin.team_assignment.unassigned')}</span>
                ) : (
                  m.teamIds.map((tid) => (
                    <Badge key={tid} variant="outline" className="text-[10px]">{teamNameById.get(tid) ?? tid.slice(0, 6)}</Badge>
                  ))
                )}
              </div>
            )}
            {/* v1.139.0: Status + Refresh chips share a single grid cell
                (flex row, no-wrap) so the mapping row stays on one line. */}
            <div className="flex flex-nowrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => toggleActive(m)}
                disabled={saving === m.id + '_toggle'}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
                  m.isActive
                    ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300'
                    : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                )}
              >
                <span className={cn('h-2 w-2 rounded-full', m.isActive ? 'bg-green-500' : 'bg-gray-400')} />
                {m.isActive ? t('admin.picklist.active') : t('admin.picklist.inactive')}
              </button>
              {!isHubspot && <button
                type="button"
                onClick={async () => {
                  // v1.140.0: refresh-only rows expose the toggle read-only —
                  // clicking the chip flips background_refresh, but if the
                  // row is refresh-only the flag is always effectively on.
                  if (m.refreshOnlyForReports) return
                  setSaving(m.id + '_bg')
                  await api.patch(`/api/admin/teams/${teamId}/sf-field-mappings/${m.id}`, { backgroundRefresh: !m.backgroundRefresh })
                  setSaving(null)
                  void reload()
                }}
                disabled={saving === m.id + '_bg' || m.refreshOnlyForReports}
                title={m.refreshOnlyForReports
                  ? t('admin.sf_mappings.refresh_only_tip', 'This field is pulled from Salesforce nightly (refresh-only mapping).')
                  : t('admin.sf_mappings.background_refresh_tip', 'Refresh this field nightly from Salesforce')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium whitespace-nowrap',
                  m.refreshOnlyForReports
                    ? 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300'
                    : m.backgroundRefresh
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                    : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                )}
              >
                {m.refreshOnlyForReports
                  ? t('admin.sf_mappings.bg_refresh_report_only', 'Refresh: report-only')
                  : m.backgroundRefresh ? t('admin.sf_mappings.bg_refresh_on', 'Refresh: on') : t('admin.sf_mappings.bg_refresh_off', 'Refresh: off')}
              </button>}
            </div>
            <div className="flex items-center justify-end gap-1">
              {isAppAdmin && (
                <details className="relative">
                  <summary className="cursor-pointer list-none rounded p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" title={t('admin.activity_types.scope')}>
                    <span className="text-xs">⋯</span>
                  </summary>
                  <div className="absolute right-0 z-10 mt-1 w-64 rounded-md border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900">
                    <TeamAssignmentPicker
                      selectedIds={m.teamIds}
                      onChange={(ids) => saveTeamIds(m, ids)}
                      disabled={saving === m.id + '_teams'}
                    />
                  </div>
                </details>
              )}
              <button
                onClick={() => openRowEdit(m)}
                className="rounded p-1.5 text-gray-400 hover:text-blue-600 disabled:opacity-50 dark:hover:text-blue-400"
                aria-label={t('common.edit')}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => remove(m)}
                disabled={saving === m.id + '_del'}
                className="rounded p-1.5 text-gray-400 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
                aria-label={t('common.delete')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          {editingRowId === m.id && (
            <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50/40 p-4 dark:border-blue-800 dark:bg-blue-950/20">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t('common.edit')}</p>
                <button onClick={() => setEditingRowId(null)} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                <div className="flex flex-col gap-1">
                  <Label>{t('admin.sf_mappings.sf_object', { context: crmCtx })}</Label>
                  {isHubspot ? (
                    <HubspotObjectSelect
                      projectObjects={projectObjects}
                      value={rowEdit.crmObject}
                      onChange={(v) => { setRowEdit({ ...rowEdit, crmObject: v, crmFieldApi: '', appField: '' }); void loadLiveFields(v) }}
                    />
                  ) : sfObjects.length > 0 ? (
                    <Select
                      value={rowEdit.crmObject}
                      onChange={(e) => { setRowEdit({ ...rowEdit, crmObject: e.target.value, crmFieldApi: '' }); void loadLiveFields(e.target.value) }}
                    >
                      {sfObjects.map((o) => (
                        <option key={o.name} value={o.name}>{o.label} ({o.name})</option>
                      ))}
                    </Select>
                  ) : (
                    <Select
                      value={rowEdit.crmObject}
                      onChange={(e) => { setRowEdit({ ...rowEdit, crmObject: e.target.value, crmFieldApi: '' }); void loadLiveFields(e.target.value) }}
                    >
                      <option value="Event">Event</option>
                      <option value="Task">Task</option>
                      <option value="Opportunity">Opportunity</option>
                      <option value="Account">Account</option>
                      <option value="Contact">Contact</option>
                      <option value="User">User</option>
                      <option value="Lead">Lead</option>
                    </Select>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <Label>{t('admin.sf_mappings.direction_label', 'Direction')}</Label>
                  <Select value={rowEdit.direction} onChange={(e) => setRowEdit({ ...rowEdit, direction: e.target.value as 'read' | 'write' | 'read_write' })}>
                    <option value="read_write">{t('admin.sf_mappings.direction_read_write', 'Read & Write')}</option>
                    <option value="write">{t('admin.sf_mappings.direction_write', 'Write only')}</option>
                    <option value="read">{t('admin.sf_mappings.direction_read', 'Read only')}</option>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label>{t('admin.sf_mappings.app_field')}</Label>
                  <Select value={rowEdit.appField} onChange={(e) => setRowEdit({ ...rowEdit, appField: e.target.value })}>
                    <option value="">—</option>
                    {appFieldOptionsFor(rowEdit.crmObject).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-1 md:col-span-1">
                  <Label>{t('admin.sf_mappings.sf_api_field', { context: crmCtx })}</Label>
                  {/* Follow the current rowEdit.crmObject (not the row's
                      stored crmObject) so switching object types
                      immediately reveals its fields. */}
                  <SfFieldSearchSelect
                    fields={liveFields[rowEdit.crmObject] ?? []}
                    value={rowEdit.crmFieldApi}
                    onChange={(v) => setRowEdit({ ...rowEdit, crmFieldApi: v })}
                    fallbackText={(liveFields[rowEdit.crmObject]?.length ?? 0) === 0}
                    t={t}
                  />
                </div>
                <div className="flex flex-col gap-1 md:col-span-2">
                  <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={rowEdit.appField === '_constant' || rowEdit.constantValue.length > 0}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setRowEdit({ ...rowEdit, constantValue: rowEdit.constantValue || ' ' })
                        } else {
                          setRowEdit({ ...rowEdit, constantValue: '', appField: rowEdit.appField === '_constant' ? '' : rowEdit.appField })
                        }
                      }}
                      className="h-3.5 w-3.5"
                    />
                    {t('admin.sf_mappings.enable_constant', { context: crmCtx })}
                  </label>
                  {(rowEdit.appField === '_constant' || rowEdit.constantValue.length > 0) && (
                    <>
                      <ConstantValueInput
                        crmObject={rowEdit.crmObject}
                        crmFieldApi={rowEdit.crmFieldApi}
                        fieldType={liveFields[rowEdit.crmObject]?.find((f) => f.apiName === rowEdit.crmFieldApi)?.type}
                        options={isHubspot ? liveFields[rowEdit.crmObject]?.find((f) => f.apiName === rowEdit.crmFieldApi)?.picklistValues : undefined}
                        value={rowEdit.constantValue.trim()}
                        onChange={(v) => setRowEdit({ ...rowEdit, constantValue: v })}
                      />
                      <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('admin.sf_mappings.constant_hint', { context: crmCtx })}</p>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id={`edit-active-${m.id}`}
                    type="checkbox"
                    checked={rowEdit.isActive}
                    onChange={(e) => setRowEdit({ ...rowEdit, isActive: e.target.checked })}
                    className="h-4 w-4"
                  />
                  <label htmlFor={`edit-active-${m.id}`} className="text-xs text-gray-700 dark:text-gray-300">
                    {t('admin.sf_mappings.active', 'Active')}
                  </label>
                </div>
                {/* v1.140.0: refresh toggles. Refresh Only For Reports
                    implies Background Refresh — the field is pulled every
                    night but not read/written by the writeback path. Both
                    are Salesforce snapshot settings, so HubSpot hides them. */}
                {!isHubspot && <>
                <div className="flex items-center gap-2">
                  <input
                    id={`edit-bg-${m.id}`}
                    type="checkbox"
                    checked={rowEdit.backgroundRefresh}
                    onChange={(e) => setRowEdit({ ...rowEdit, backgroundRefresh: e.target.checked })}
                    className="h-4 w-4"
                  />
                  <label htmlFor={`edit-bg-${m.id}`} className="text-xs text-gray-700 dark:text-gray-300">
                    {t('admin.sf_mappings.background_refresh_label', 'Background refresh (nightly)')}
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id={`edit-ro-${m.id}`}
                    type="checkbox"
                    checked={rowEdit.refreshOnlyForReports}
                    onChange={(e) => setRowEdit({ ...rowEdit, refreshOnlyForReports: e.target.checked })}
                    className="h-4 w-4"
                  />
                  <label htmlFor={`edit-ro-${m.id}`} className="text-xs text-gray-700 dark:text-gray-300">
                    {t('admin.sf_mappings.refresh_only_label', 'Refresh only for reports (no writeback)')}
                  </label>
                </div>
                </>}
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={() => saveRowEdit(m)} disabled={saving === m.id || !rowEdit.appField || !rowEdit.crmFieldApi.trim()}>
                  {saving === m.id && <Spinner className="mr-1 h-3 w-3" />}
                  <Save className="mr-1 h-3.5 w-3.5" />{t('common.save')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditingRowId(null)}><X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}</Button>
              </div>
            </div>
          )}
          </div>
                  ))}
                </div>
              )}
            </div>
          ))
        })()}
        {visibleMappings.length === 0 && !adding && (
          <p className="py-6 text-center text-sm text-gray-400 dark:text-gray-500">{t('admin.sf_mappings.empty', { context: crmCtx })}</p>
        )}
        {hiddenCount > 0 && (
          <p className="flex items-center gap-1.5 px-1 text-[11px] text-gray-500 dark:text-gray-400">
            <EyeOff className="h-3.5 w-3.5 shrink-0" />
            {t('admin.sf_mappings.hidden_other_crm', { count: hiddenCount, other: CRM_DISPLAY_NAMES[isHubspot ? 'salesforce' : 'hubspot'].name })}
          </p>
        )}
      </div>

      {adding ? (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
          <p className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">{t('admin.sf_mappings.add_mapping')}</p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div className="flex flex-col gap-1">
              <Label>{t('admin.sf_mappings.sf_object', { context: crmCtx })}</Label>
              {isHubspot ? (
                <HubspotObjectSelect projectObjects={projectObjects} value={form.crmObject} onChange={(v) => setForm((f) => ({ ...f, crmObject: v, crmFieldApi: '', appField: '' }))} />
              ) : sfObjects.length > 0 ? (
                <Select value={form.crmObject} onChange={(e) => setForm((f) => ({ ...f, crmObject: e.target.value }))}>
                  {sfObjects.map((o) => (
                    <option key={o.name} value={o.name}>{o.label} ({o.name})</option>
                  ))}
                </Select>
              ) : (
                <Select value={form.crmObject} onChange={(e) => setForm((f) => ({ ...f, crmObject: e.target.value }))}>
                  <option value="Event">Event</option>
                  <option value="Task">Task</option>
                  <option value="Opportunity">Opportunity</option>
                  <option value="Account">Account</option>
                  <option value="Contact">Contact</option>
                  <option value="User">User</option>
                  <option value="Lead">Lead</option>
                </Select>
              )}
              <p className="text-[10px] text-gray-400 dark:text-gray-500">
                {isHubspot
                  ? t('admin.sf_mappings.hubspot_objects_hint')
                  : sfObjectsLoading
                  ? t('common.loading')
                  : sfObjects.length > 0
                    ? t('admin.sf_mappings.sf_objects_live', { count: sfObjects.length, defaultValue: '{{count}} SF SObjects loaded live' })
                    : sfObjectsError
                      ? t('admin.sf_mappings.sf_objects_offline', 'Could not load SObjects from Salesforce — showing common types.')
                      : t('admin.sf_mappings.sf_objects_default', 'Connect the SF admin identity for the full SObject list.')}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.sf_mappings.direction_label', 'Direction')}</Label>
              <Select value={form.direction} onChange={(e) => setForm((f) => ({ ...f, direction: e.target.value as 'read' | 'write' | 'read_write' }))}>
                <option value="read_write">{t('admin.sf_mappings.direction_read_write', 'Read & Write')}</option>
                <option value="write">{t('admin.sf_mappings.direction_write', 'Write only')}</option>
                <option value="read">{t('admin.sf_mappings.direction_read', 'Read only')}</option>
              </Select>
              <p className="text-[10px] text-gray-400 dark:text-gray-500">
                {t('admin.sf_mappings.direction_hint', { context: crmCtx })}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.sf_mappings.app_field')}</Label>
              <Select
                value={form.appField}
                onChange={(e) => setForm((f) => ({ ...f, appField: e.target.value }))}
              >
                <option value="">—</option>
                {appFieldOptionsFor(form.crmObject).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
              <p className="font-mono text-[10px] text-gray-400 dark:text-gray-500">
                {appFieldOptionsFor(form.crmObject).find((o) => o.value === form.appField)?.hint ?? '—'}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.sf_mappings.sf_api_field', { context: crmCtx })}</Label>
              {usingLive ? (
                <SfFieldSearchSelect
                  fields={live}
                  value={form.crmFieldApi}
                  onChange={(v) => setForm((f) => ({ ...f, crmFieldApi: v }))}
                  fallbackText={false}
                  t={t}
                />
              ) : (
                <Input
                  list={datalistId}
                  value={form.crmFieldApi}
                  onChange={(e) => setForm((f) => ({ ...f, crmFieldApi: e.target.value }))}
                  className="font-mono text-xs"
                  placeholder={liveLoading[form.crmObject] ? t('common.loading') : undefined}
                />
              )}
              <datalist id={datalistId}>
                {fieldOptions.map((opt) => <option key={opt.value} value={opt.value} label={opt.label !== opt.value ? opt.label : undefined} />)}
              </datalist>
              <p className="text-[10px] text-gray-400 dark:text-gray-500">
                {usingLive
                  ? t('admin.sf_mappings.live_source', { count: live.length, context: crmCtx })
                  : liveFetchError
                    ? t('admin.sf_mappings.live_unavailable', { context: crmCtx })
                    : t('admin.sf_mappings.connect_admin_for_live', { context: crmCtx })}
              </p>
            </div>
            {/* v1.71.0: constant-value opt-in via checkbox — any mapping
                can be flipped into "write a fixed value to SF" mode
                without switching the App Field to (Constant value). The
                checkbox is checked whenever a constant is set or the
                app field is (Constant value). Unchecking wipes the
                stored value on save. */}
            <div className="flex flex-col gap-1 md:col-span-2">
              <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={form.appField === '_constant' || form.constantValue.length > 0}
                  onChange={(e) => {
                    if (e.target.checked) {
                      // Turn on the constant panel without hijacking the
                      // app-field choice, so admins can leave title/etc
                      // mapped normally AND still write a constant. Empty
                      // string keeps the type-aware input rendering.
                      setForm((f) => ({ ...f, constantValue: f.constantValue || ' ' }))
                    } else {
                      setForm((f) => ({ ...f, constantValue: '', appField: f.appField === '_constant' ? '' : f.appField }))
                    }
                  }}
                  className="h-3.5 w-3.5"
                />
                {t('admin.sf_mappings.enable_constant', { context: crmCtx })}
              </label>
              {(form.appField === '_constant' || form.constantValue.length > 0) && (
                <>
                  <ConstantValueInput
                    crmObject={form.crmObject}
                    crmFieldApi={form.crmFieldApi}
                    fieldType={liveFields[form.crmObject]?.find((f) => f.apiName === form.crmFieldApi)?.type}
                    options={isHubspot ? liveFields[form.crmObject]?.find((f) => f.apiName === form.crmFieldApi)?.picklistValues : undefined}
                    value={form.constantValue.trim()}
                    onChange={(v) => setForm((f) => ({ ...f, constantValue: v }))}
                  />
                  <p className="text-[10px] text-gray-400 dark:text-gray-500">{t('admin.sf_mappings.constant_hint', { context: crmCtx })}</p>
                </>
              )}
            </div>
          </div>
          {/* v1.141.0: same three checkboxes as the Edit modal — Active,
              Background refresh, Refresh only for reports. */}
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} className="h-4 w-4" />
              {t('admin.sf_mappings.active', 'Active')}
            </label>
            {!isHubspot && <><label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={form.backgroundRefresh} onChange={(e) => setForm((f) => ({ ...f, backgroundRefresh: e.target.checked }))} className="h-4 w-4" />
              {t('admin.sf_mappings.background_refresh_label', 'Background refresh (nightly)')}
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={form.refreshOnlyForReports} onChange={(e) => setForm((f) => ({ ...f, refreshOnlyForReports: e.target.checked }))} className="h-4 w-4" />
              {t('admin.sf_mappings.refresh_only_label', 'Refresh only for reports (no writeback)')}
            </label></>}
          </div>
          {isAppAdmin && (
            <div className="mt-3">
              <TeamAssignmentPicker
                selectedIds={form.teamIds}
                onChange={(ids) => setForm((f) => ({ ...f, teamIds: ids }))}
              />
            </div>
          )}
          {addError && (
            <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              {addError}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={submitAdd} disabled={saving === 'add' || !form.appField.trim() || !form.crmFieldApi.trim()}>
              {saving === 'add' && <Spinner className="mr-1 h-3 w-3" />}
              <Save className="mr-1 h-3.5 w-3.5" />{t('common.save')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setForm(emptyForm); setAddError(null) }}><X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            {t('admin.sf_mappings.add_mapping')}
          </Button>
          {isAppAdmin && (
            <>
              <Button size="sm" variant="outline" onClick={handleExport} disabled={exporting}>
                {exporting ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Download className="mr-1 h-3.5 w-3.5" />}
                {t('admin.sf_mappings.export', 'Export')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={importPreviewLoading}>
                {importPreviewLoading ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
                {t('admin.sf_mappings.import', 'Import')}
              </Button>
              <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleImportFileSelected} />
            </>
          )}
        </div>
      )}

      {importError && !importDoc && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {importError}
        </p>
      )}
      {importResult && (
        <p className="flex items-center gap-1.5 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          {t('admin.sf_mappings.import_applied', '{{created}} created, {{updated}} updated, {{skipped}} unchanged.', importResult)}
        </p>
      )}
      {(importDoc && importDiff) && (
        <SfMappingImportPreviewModal
          doc={importDoc}
          diff={importDiff}
          applying={importApplying}
          error={importError}
          onApply={applyImport}
          onClose={closeImportModal}
          t={t}
        />
      )}
    </div>
  )
}

// v1.299.0: import diff preview — "call out any issues when there's been a
// change since it was exported" lives here: every changing field is shown
// old -> new so the admin can see EXACTLY what's about to move before
// confirming, not just a bare row count.
function SfMappingImportPreviewModal({ doc, diff, applying, error, onApply, onClose, t }: {
  doc: SfMappingImportDocument
  diff: SfMappingImportDiff
  applying: boolean
  error: string | null
  onApply: () => void
  onClose: () => void
  t: TFunction
}) {
  const hasChanges = diff.toCreate.length > 0 || diff.toUpdate.length > 0
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-5 shadow-xl dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.sf_mappings.import_preview_title')}
          </p>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
          {t('admin.sf_mappings.import_preview_source', {
            when: new Date(doc.exportedAt).toLocaleString(),
            who: doc.exportedByEmail ?? t('admin.sf_mappings.import_unknown'),
            team: doc.sourceTeamName ?? doc.sourceTeamSlug ?? t('admin.sf_mappings.import_unknown'),
          })}
        </p>

        {diff.toCreate.length > 0 && (
          <div className="mb-3">
            <p className="mb-1 text-xs font-semibold text-green-700 dark:text-green-400">
              {t('admin.sf_mappings.import_to_create', { count: diff.toCreate.length })}
            </p>
            <ul className="flex flex-col gap-0.5 text-xs text-gray-600 dark:text-gray-400">
              {diff.toCreate.map((r) => (
                <li key={`${r.appField}-${r.crmObject}`} className="flex items-center gap-1.5">
                  <span className="font-mono">{r.crmObject} / {r.appField}</span>
                  {r.unresolvedTeamSlugs && r.unresolvedTeamSlugs.length > 0 && (
                    <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400" title={t('admin.sf_mappings.import_unresolved_slugs_tip')}>
                      <AlertTriangle className="h-3 w-3" />
                      {t('admin.sf_mappings.import_unresolved_slugs', { slugs: r.unresolvedTeamSlugs.join(', ') })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {diff.toUpdate.length > 0 && (
          <div className="mb-3">
            <p className="mb-1 text-xs font-semibold text-amber-700 dark:text-amber-400">
              {t('admin.sf_mappings.import_to_update', { count: diff.toUpdate.length })}
            </p>
            <ul className="flex flex-col gap-2 text-xs">
              {diff.toUpdate.map((r) => (
                <li key={`${r.appField}-${r.crmObject}`} className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 dark:border-amber-900 dark:bg-amber-950/30">
                  <span className="font-mono text-gray-800 dark:text-gray-200">{r.crmObject} / {r.appField}</span>
                  <ul className="mt-1 flex flex-col gap-0.5 pl-2 text-[11px] text-gray-600 dark:text-gray-400">
                    {(r.changes ?? []).map((c, i) => (
                      <li key={i}>
                        <span className="font-medium">{c.field}:</span>{' '}
                        <span className="text-red-600 dark:text-red-400">{JSON.stringify(c.from)}</span>{' → '}
                        <span className="text-green-700 dark:text-green-400">{JSON.stringify(c.to)}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        )}

        {diff.unchanged.length > 0 && (
          <p className="mb-2 text-xs text-gray-400">
            {t('admin.sf_mappings.import_unchanged', { count: diff.unchanged.length })}
          </p>
        )}
        {diff.notInFile.length > 0 && (
          <p className="mb-2 text-xs text-gray-400">
            {t('admin.sf_mappings.import_not_in_file', { count: diff.notInFile.length })}
          </p>
        )}
        {!hasChanges && (
          <p className="mb-2 text-xs text-gray-500">{t('admin.sf_mappings.import_nothing_to_do')}</p>
        )}

        {error && (
          <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="sm" onClick={onApply} disabled={applying || !hasChanges}>
            {applying && <Spinner className="mr-1 h-3.5 w-3.5" />}
            {t('admin.sf_mappings.import_apply')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// Searchable, alphabetized dropdown for SF fields. Types a filter
// query into an Input that narrows the native <select> options —
// keeps keyboard flow and screen-reader semantics of a real select
// while giving admins a fast way to find a field in a 200-item list.
// The HubSpot objects a mapping can target (HUBSPOT_MAPPABLE_OBJECTS).
// Plus the portal's Project objects (phase 6b).
function HubspotObjectSelect({ value, onChange, projectObjects }: { value: string; onChange: (v: string) => void; projectObjects: HubspotProjectObject[] }) {
  const { t } = useTranslation()
  const known = isHubspotMappingObject(value) || projectObjects.some((o) => o.objectTypeId === value)
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      {!known && <option value={value}>{value}</option>}
      {HUBSPOT_MAPPABLE_OBJECTS.map((o) => (
        <option key={o} value={o}>{t(`admin.sf_mappings.hubspot_objects.${o}`)} ({o})</option>
      ))}
      {projectObjects.map((o) => (
        <option key={o.objectTypeId} value={o.objectTypeId}>{projectObjectName(o.objectTypeId, projectObjects, t)} ({o.objectTypeId})</option>
      ))}
    </Select>
  )
}

function projectObjectName(objectTypeId: string, objects: HubspotProjectObject[], t: ReturnType<typeof useTranslation>['t']): string {
  const o = objects.find((x) => x.objectTypeId === objectTypeId)
  if (!o || o.standard) return t('admin.sf_mappings.hubspot_objects.projects')
  return o.label ?? objectTypeId
}

function SfFieldSearchSelect({ fields, value, onChange, fallbackText, t }: {
  fields: LiveSfField[]
  value: string
  onChange: (v: string) => void
  fallbackText: boolean
  t: ReturnType<typeof useTranslation>['t']
}) {
  // All hooks must be called in the same order on every render — do
  // NOT put a useState after a conditional return, or React throws
  // #310 the moment `fields` transitions from empty (early-return
  // path, 1 hook) to non-empty (2 hooks).
  const [q, setQ] = useState('')
  // The multi-row picker is only useful while the admin is actively
  // browsing. Default collapsed even for empty values — the admin
  // opts in by focusing the search input (or clicking Change on a
  // picked value). Otherwise a fresh Add-mapping form dumps the full
  // 100+ field list on screen before the admin has done anything.
  const [browsing, setBrowsing] = useState(false)
  // Sort alphabetically by label (falling back to apiName) so admins
  // aren't hunting through SF's random describe order.
  const sorted = [...fields].sort((a, b) => (a.label ?? a.apiName).localeCompare(b.label ?? b.apiName))
  const filtered = q.trim()
    ? sorted.filter((f) => {
        const needle = q.trim().toLowerCase()
        return f.apiName.toLowerCase().includes(needle) || (f.label ?? '').toLowerCase().includes(needle)
      })
    : sorted
  if (fallbackText || fields.length === 0) {
    // No live field list — fall back to a text input; the caller
    // renders a datalist for autocomplete.
    return <Input value={value} onChange={(e) => onChange(e.target.value)} className="font-mono text-xs" />
  }
  const selectedField = fields.find((f) => f.apiName === value)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" />
          <Input
            value={q}
            onFocus={() => setBrowsing(true)}
            onChange={(e) => { setQ(e.target.value); setBrowsing(true) }}
            placeholder={t('admin.sf_mappings.field_search_placeholder', 'Search fields…')}
            className="pl-6 text-xs"
          />
        </div>
        {value && !browsing && (
          <div className="inline-flex min-w-0 items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-100" title={value}>
            <span className="truncate font-medium">{selectedField ? `${selectedField.label} (${selectedField.apiName})` : value}</span>
            <button
              type="button"
              onClick={() => setBrowsing(true)}
              className="text-blue-700 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-100"
              title={t('admin.sf_mappings.field_change', 'Change')}
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => { onChange(''); setBrowsing(true) }}
              className="text-blue-700 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-100"
              title={t('admin.sf_mappings.field_clear', 'Clear')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
      {browsing && (
        // Raw <select> here — the shared <Select> hard-codes h-9,
        // which overrides the size attribute and collapses the box to
        // a single row. This one honors size=10 and shows ~10 rows.
        <select
          value={value}
          onChange={(e) => { onChange(e.target.value); if (e.target.value) setBrowsing(false) }}
          size={Math.min(14, Math.max(10, filtered.length + 1))}
          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="">—</option>
          {filtered.map((f) => (
            <option key={f.apiName} value={f.apiName}>{`${f.label} (${f.apiName})${f.readOnly ? ` · ${t('admin.sf_mappings.read_only_suffix')}` : ''}`}</option>
          ))}
        </select>
      )}
      {q && filtered.length === 0 && (
        <p className="text-[10px] italic text-gray-500 dark:text-gray-400">{t('admin.sf_mappings.field_search_empty', 'No fields match — try a different term or clear search.')}</p>
      )}
    </div>
  )
}

// v1.70.0: type-aware constant-value input for `_constant` app-field
// mappings. Renders a checkbox for booleans, a number input for numeric
// SF types, a picklist dropdown when the field is a picklist (values
// fetched on demand from /api/admin/sf/picklist-values), otherwise
// plain text. Falls back to text whenever the type is unknown so
// admins never lose the ability to type something in.
function ConstantValueInput({ crmObject, crmFieldApi, fieldType, options, value, onChange }: {
  crmObject: string
  crmFieldApi: string
  fieldType: string | undefined
  // Known options (a HubSpot property's); skips the Salesforce picklist fetch.
  options?: Array<{ value: string; label: string }> | undefined
  value: string
  onChange: (v: string) => void
}) {
  const [picklist, setPicklist] = useState<Array<{ value: string; label: string; active: boolean }>>([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (options) { setPicklist(options.map((o) => ({ ...o, active: true }))); return }
    if (fieldType !== 'picklist' || !crmObject || !crmFieldApi) { setPicklist([]); return }
    let cancelled = false
    setLoading(true)
    void (async () => {
      const res = await api.get<{ values: Array<{ value: string; label: string; active: boolean }> }>(`/api/admin/sf/picklist-values?object=${encodeURIComponent(crmObject)}&field=${encodeURIComponent(crmFieldApi)}`)
      if (!cancelled) {
        setPicklist(res.data?.values ?? [])
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [crmObject, crmFieldApi, fieldType, options])

  if (fieldType === 'boolean') {
    return (
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
          className="h-4 w-4"
        />
        <span className="text-xs text-gray-600 dark:text-gray-400">{value === 'true' ? 'true' : 'false'}</span>
      </label>
    )
  }
  if (fieldType === 'picklist') {
    return (
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={loading} className="text-xs">
        <option value="">{loading ? 'Loading…' : '—'}</option>
        {picklist.map((p) => (
          <option key={p.value} value={p.value} disabled={!p.active}>{p.label}{!p.active ? ' (inactive)' : ''}</option>
        ))}
      </Select>
    )
  }
  if (fieldType === 'int' || fieldType === 'double' || fieldType === 'currency' || fieldType === 'percent') {
    return (
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={fieldType === 'currency' ? '0.00' : '0'}
        className="text-xs"
      />
    )
  }
  if (fieldType === 'date') {
    return <Input type="date" value={value} onChange={(e) => onChange(e.target.value)} className="text-xs" />
  }
  if (fieldType === 'datetime') {
    return <Input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} className="text-xs" />
  }
  return <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Completed" className="text-xs" />
}
