import { useTranslation } from 'react-i18next'
import {
  Activity,
  CheckCircle2,
  ClipboardCheck,
  Link as LinkIcon,
  ListChecks,
  MessageSquare,
  NotebookPen,
  Sparkles,
  Wallet,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '../../ui/badge.js'
import type { AiFeature } from '../../../../shared/ai.js'

// Shared by the AI Assistant page and its Usage this month panel.

// The icon of the page or tab each AI feature lives on, so the routing list
// and the usage tables read like the rest of the app (v1.465.0).
export const FEATURE_ICONS: Record<AiFeature, LucideIcon> = {
  activity_classify: ListChecks,
  note_organize: NotebookPen,
  note_link_suggest: LinkIcon,
  notes_chat: MessageSquare,
  activity_ai_notes: Sparkles,
  activity_ai_assessments: ClipboardCheck,
}

// Usage rows also carry features that aren't routable (the provider test).
export function featureIcon(feature: string): LucideIcon {
  return (FEATURE_ICONS as Record<string, LucideIcon | undefined>)[feature] ?? Activity
}

export function usd(n: number): string {
  return `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`
}

export function StatusPill({ status }: { status: string }) {
  const { t } = useTranslation()
  const ok = status === 'ok'
  return (
    <Badge variant={ok ? 'success' : status === 'over_budget' ? 'warning' : 'destructive'} className="inline-flex items-center gap-1">
      {ok ? <CheckCircle2 className="h-3 w-3" /> : status === 'over_budget' ? <Wallet className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {t(`ai_assistant.statuses.${status}`)}
    </Badge>
  )
}
