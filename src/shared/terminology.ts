// App-wide terminology (Admin → Workplace → Terminology), the ImpactIQ side of
// CriteriaIQ's own terminology setting: what this org calls a technical
// evaluation. It names the seeded "{term} Work" Activity Type, the default
// Guide Distinctions and nudge rule, and the {{evalTerm}} / {{evalWork}}
// variables in UI strings. Fresh installs default to POx; installs that
// already had the old "Eval Work" type were pinned to Eval by migration 0171,
// so nothing changes for them until an App Admin picks another term.
export const EVAL_TERM_OPTIONS = ['eval', 'poc', 'pov', 'pox', 'project', 'custom'] as const
export type EvalTermOption = typeof EVAL_TERM_OPTIONS[number]

export interface Terminology {
  evalTerm: EvalTermOption
  // Only used (and only kept) when evalTerm is 'custom'.
  customEvalTerm: string | null
}

export const DEFAULT_TERMINOLOGY: Terminology = { evalTerm: 'pox', customEvalTerm: null }

// The fixed options' words. Acronyms and the word "Project" are kept as the
// org types them in the CRM, so they are not translated.
export const EVAL_TERM_LABELS: Record<Exclude<EvalTermOption, 'custom'>, string> = {
  eval: 'Eval',
  poc: 'POC',
  pov: 'POV',
  pox: 'POx',
  project: 'Project',
}

// The Activity Type name every default list was written against. Used as the
// key into those lists (styles, Guide content, keyword rules), which then
// resolve to the install's own term.
export const LEGACY_EVAL_WORK_NAME = 'Eval Work'

export const CUSTOM_EVAL_TERM_MAX = 24
// Letters (any script), digits, spaces and a little punctuation; no control
// characters or markup, since the term ends up in Activity Type names, nudge
// text and every locale's strings.
export const CUSTOM_EVAL_TERM_RX = /^[\p{L}\p{N}][\p{L}\p{N} .&/+-]*$/u

export function cleanCustomEvalTerm(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().replace(/\s+/g, ' ')
  if (!v || v.length > CUSTOM_EVAL_TERM_MAX || !CUSTOM_EVAL_TERM_RX.test(v)) return null
  return v
}

export function normalizeTerminology(raw: unknown): Terminology {
  const v = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const term = (EVAL_TERM_OPTIONS as readonly string[]).includes(String(v['evalTerm'])) ? v['evalTerm'] as EvalTermOption : DEFAULT_TERMINOLOGY.evalTerm
  if (term !== 'custom') return { evalTerm: term, customEvalTerm: null }
  const custom = cleanCustomEvalTerm(v['customEvalTerm'])
  // A custom choice without a usable word falls back to the default.
  return custom ? { evalTerm: 'custom', customEvalTerm: custom } : DEFAULT_TERMINOLOGY
}

// "POx", "POC", "Eval", or the custom word.
export function evalTermLabel(t: Terminology): string {
  if (t.evalTerm === 'custom') return t.customEvalTerm ?? EVAL_TERM_LABELS.pox
  return EVAL_TERM_LABELS[t.evalTerm]
}

// The seeded Activity Type's name: "POx Work", "Eval Work", ...
export function evalWorkTypeName(t: Terminology): string {
  return `${evalTermLabel(t)} Work`
}

// i18n default variables: {{evalTerm}} and {{evalWork}}.
export function terminologyWordingVariables(t: Terminology): { evalTerm: string; evalWork: string } {
  return { evalTerm: evalTermLabel(t), evalWork: evalWorkTypeName(t) }
}

// Maps an install's Activity Type name back to the key the default lists use,
// so "POx Work" (or a kept "Eval Work") finds the evaluation type's defaults.
export function defaultTypeKey(name: string, evalWorkName: string): string {
  return name === evalWorkName ? LEGACY_EVAL_WORK_NAME : name
}

// Replaces whole-word occurrences of one Activity Type name in admin text
// (Guide Distinctions, nudge messages). Exact case, so "eval work" written
// as prose is left alone.
export function replaceTypeName(text: string, from: string, to: string): string {
  if (!from || from === to) return text
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu'), to)
}
