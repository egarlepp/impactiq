import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../lib/api.js'
import { DEFAULT_EVALUATION_SOURCE, crmProjectsActive, isEvaluationSourceId, projectsEnabled, type EvaluationSourceId } from '../../shared/evaluationSource.js'

// Where Projects come from (Admin → Integrations → Projects). Fetched once per
// page load on first use and shared by every component; the admin card calls
// setEvaluationSourceState() after a change. Until the fetch answers, the CRM
// default applies (Projects on), matching the server's default, so a slow
// fetch never hides Project features that are actually on.
export interface ClientEvaluationSource {
  primary: EvaluationSourceId
  criteriaiqSecondary: boolean
}

let current: ClientEvaluationSource = { primary: DEFAULT_EVALUATION_SOURCE, criteriaiqSecondary: false }
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function setEvaluationSourceState(next: ClientEvaluationSource) {
  current = next
  listeners.forEach((cb) => { cb() })
}

function ensureLoaded() {
  if (loading) return
  loading = api.get<ClientEvaluationSource>('/api/crm/evaluation-source').then((res) => {
    if (res.data && isEvaluationSourceId(res.data.primary)) {
      setEvaluationSourceState({ primary: res.data.primary, criteriaiqSecondary: res.data.criteriaiqSecondary === true })
    } else loading = null // retry on the next mount rather than sticking on defaults
  }).catch(() => { loading = null })
}

export function useEvaluationSource(): ClientEvaluationSource {
  useEffect(() => { ensureLoaded() }, [])
  return useSyncExternalStore(subscribe, () => current, () => current)
}

// False when an App Admin has turned Projects off: every Project feature
// (picker, chips, panels, Engineer Notes, Project dashboards) is hidden.
export function useProjectsEnabled(): boolean {
  return projectsEnabled(useEvaluationSource().primary)
}

// True only while the CRM's own Evaluation object is the Project source.
// Salesforce-only Project features (the Evaluation picker and editor,
// Engineer Notes posting, the Evaluation hover preview) need it; with
// CriteriaIQ as the primary source the CriteriaIQ project picker shows instead.
export function useCrmProjects(): boolean {
  return crmProjectsActive(useEvaluationSource().primary)
}
