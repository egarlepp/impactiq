import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle, Clock, CircleSlash, User, type LucideIcon } from 'lucide-react'
import { Badge } from '../ui/badge.js'

// v1.239.0: shared attendee-response badge, one icon+label per REAL Microsoft
// Graph `attendee.status.response` value (none | organizer | tentativelyAccepted
// | accepted | declined | notResponded) — see EventDetailsModal.tsx (the
// original, icon-less inline version of this) and ActivityForm.tsx's
// read-only "meeting responses" summary. Centralized here so both stay in
// sync instead of drifting into two copies of the same icon/variant map.
const RESPONSE_ICON: Record<string, LucideIcon> = {
  accepted: CheckCircle2,
  declined: XCircle,
  tentativelyAccepted: Clock,
  notResponded: CircleSlash,
  none: CircleSlash,
  organizer: User,
}

export function AttendeeResponseBadge({ response, className }: { response: string; className?: string }) {
  const { t } = useTranslation()
  const Icon = RESPONSE_ICON[response] ?? CircleSlash
  const variant = response === 'accepted' ? 'success' : response === 'declined' ? 'destructive' : 'secondary'
  return (
    <Badge variant={variant} className={className ? `inline-flex items-center gap-1 ${className}` : 'inline-flex items-center gap-1'}>
      <Icon className="h-3 w-3" />
      {t(`calendar.event_details.response.${response}`, response)}
    </Badge>
  )
}
