import { useNavigate } from 'react-router-dom'
import { Chip } from '../ui/chip.js'
import type { AnomalyResult } from '../../lib/anomalies.js'

interface Props {
  anomalies: AnomalyResult[]
  // If set, clicking the badge navigates to the activities page filtered to
  // the given contributor + optional range.
  userId?: string
  startDate?: string
  endDate?: string
}

// Renders zero or more compact chips for the anomalies detected on a
// single contributor. Chips are clickable and drill into the activities
// page pre-filtered to that contributor.
export function AnomalyBadge({ anomalies, userId, startDate, endDate }: Props) {
  const navigate = useNavigate()
  if (!anomalies.length) return null

  function go() {
    if (!userId) return
    const params = new URLSearchParams()
    params.set('userId', userId)
    if (startDate) params.set('startDate', startDate)
    if (endDate) params.set('endDate', endDate)
    navigate(`/activities?${params.toString()}`)
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {anomalies.map((a) => (
        <Chip
          key={a.code}
          size="xs"
          variant={a.severity === 'red' ? 'danger' : 'warning'}
          title={a.message}
          onClick={userId ? go : undefined}
          className={userId ? 'cursor-pointer hover:opacity-80' : ''}
        >
          {a.message}
        </Chip>
      ))}
    </span>
  )
}
