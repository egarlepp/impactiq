// Where an activity's Project (Evaluation) comes from. One install-wide
// choice, set by an App Admin beside the CRM choice:
//
//   'crm'        the CRM's own Evaluation object (Salesforce Evaluations__c
//                today). The default, so every existing install is unchanged.
//   'criteriaiq' projects in CriteriaIQ, for an install whose CRM has no
//                Evaluation object (e.g. HubSpot Professional).
//   'off'        no Project features.
//
// With the CRM as primary, CriteriaIQ can also run as a secondary source:
// it adds what the CRM object doesn't carry (criteria progress, a link out to
// the CriteriaIQ project) and never overrides the CRM's values.
export const EVALUATION_SOURCE_IDS = ['crm', 'criteriaiq', 'off'] as const
export type EvaluationSourceId = typeof EVALUATION_SOURCE_IDS[number]
export type EvaluationDataSource = Exclude<EvaluationSourceId, 'off'>

export const DEFAULT_EVALUATION_SOURCE: EvaluationSourceId = 'crm'

export function isEvaluationSourceId(v: unknown): v is EvaluationSourceId {
  return typeof v === 'string' && (EVALUATION_SOURCE_IDS as readonly string[]).includes(v)
}

// Stored in system_settings as { primary, dataSource, criteriaiqSecondary }.
// `dataSource` remembers which source the install's Project links came from,
// the same idea as the CRM provider's `dataProvider`: links from one source
// are ids the other doesn't know.
export interface EvaluationSourceSetting {
  primary: EvaluationSourceId
  dataSource: EvaluationDataSource
  criteriaiqSecondary: boolean
}

// Anything unreadable falls back to the default (CRM primary, no secondary)
// rather than turning Project features off by accident.
export function normalizeEvaluationSourceSetting(raw: unknown): EvaluationSourceSetting {
  const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const primary = isEvaluationSourceId(r['primary']) ? r['primary'] : DEFAULT_EVALUATION_SOURCE
  const d = r['dataSource']
  const dataSource: EvaluationDataSource = isEvaluationSourceId(d) && d !== 'off'
    ? d
    : primary === 'off' ? 'crm' : primary
  return { primary, dataSource, criteriaiqSecondary: secondaryAllowed(primary) && r['criteriaiqSecondary'] === true }
}

// CriteriaIQ as a secondary only makes sense beside a CRM object; with
// CriteriaIQ as primary it would be its own secondary.
export function secondaryAllowed(primary: EvaluationSourceId): boolean {
  return primary === 'crm'
}

// Whether the primary may move to `to`. Once activities link to Projects, only
// the links' own source or 'off' is allowed, since switching would orphan
// them. The secondary is never locked: it stores only a cached CriteriaIQ id.
export function evaluationSourceChangeAllowed(setting: EvaluationSourceSetting, to: EvaluationSourceId, hasProjectLinks: boolean): boolean {
  if (to === setting.primary || !hasProjectLinks) return true
  return to === 'off' || to === setting.dataSource
}

// Off means no Project features anywhere: no picker, no Project panels, no
// Project dashboards. Links already saved stay in the database untouched, so
// turning Projects back on (to the links' own source) restores them.
export function projectsEnabled(primary: EvaluationSourceId): boolean {
  return primary !== 'off'
}

interface RelatedLink { crmRelatedId?: string | null | undefined }

// True when a save would CREATE or CHANGE a Project link while Projects are
// off. Keeping an activity's existing link, or clearing it, is always allowed,
// so turning Projects off never blocks editing an older activity. Same
// contract as the Campaigns/Leads switches (src/shared/crmFeatures.ts).
export function isBlockedProjectLink(primary: EvaluationSourceId, incoming: RelatedLink, existing?: RelatedLink | null): boolean {
  if (projectsEnabled(primary)) return false
  if (!incoming.crmRelatedId) return false
  return incoming.crmRelatedId !== existing?.crmRelatedId
}

// Project links made while CriteriaIQ is the primary source store this in
// activities.crm_related_type, with the CriteriaIQ project id in crm_related_id.
// Never a Salesforce object name (those always end in __c or are standard
// objects), so a CriteriaIQ link can't be mistaken for a CRM record.
export const CRITERIAIQ_RELATED_TYPE = 'CriteriaIQ'

export function isCriteriaIqProjectLink(crmRelatedType: string | null | undefined): boolean {
  return crmRelatedType === CRITERIAIQ_RELATED_TYPE
}

// The CRM's own Evaluation object is the Project source: Salesforce-only
// features (the Evaluation picker and editor, Engineer Notes posting, the
// Evaluation preview) work only then.
export function crmProjectsActive(primary: EvaluationSourceId): boolean {
  return primary === 'crm'
}

interface TypedRelatedLink extends RelatedLink { crmRelatedType?: string | null | undefined }

// True when a save would create or change a Project link that doesn't belong
// to the current primary source: with CriteriaIQ as primary only CriteriaIQ
// project ids, with the CRM as primary only CRM records. Keeping an existing
// link or clearing one is always allowed, same as isBlockedProjectLink.
export function isWrongSourceProjectLink(primary: EvaluationSourceId, incoming: TypedRelatedLink, existing?: RelatedLink | null): boolean {
  if (!projectsEnabled(primary)) return false
  if (!incoming.crmRelatedId || incoming.crmRelatedId === existing?.crmRelatedId) return false
  const isCriteriaIq = isCriteriaIqProjectLink(incoming.crmRelatedType)
  if (primary === 'criteriaiq') return !isCriteriaIq || !/^[1-9][0-9]{0,15}$/.test(incoming.crmRelatedId)
  return isCriteriaIq
}
