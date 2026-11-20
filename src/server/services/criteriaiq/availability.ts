import type { EvaluationSourceId } from '../../../shared/evaluationSource.js'

// Which choices this build can act on. The CRM object is the primary source,
// and CriteriaIQ can run beside it as the secondary (the activity drawer's
// CriteriaIQ panel, v1.386.0). Off (v1.387.0) hides every Project feature.
// CriteriaIQ as primary (v1.388.0) has its own project picker, a nightly
// snapshot refresh and the Project dashboards.
export function availableEvaluationSources(): EvaluationSourceId[] {
  return ['crm', 'criteriaiq', 'off']
}

export function criteriaIqSecondaryAvailable(): boolean {
  return true
}
