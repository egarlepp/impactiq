// Color for an AI Assessment score (0–100), shared by the drawer's
// Assessments tab and the AI Assessment Scores dashboard.
export function scoreTone(score: number | null): string {
  if (score === null) return 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300'
  if (score >= 75) return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
  if (score >= 50) return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
  return 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300'
}

// Bar fill for an average criterion level (1–5).
export function levelBarTone(level: number | null): string {
  if (level === null) return 'bg-gray-300 dark:bg-gray-600'
  if (level >= 4) return 'bg-emerald-500 dark:bg-emerald-400'
  if (level >= 3) return 'bg-amber-500 dark:bg-amber-400'
  return 'bg-rose-500 dark:bg-rose-400'
}
