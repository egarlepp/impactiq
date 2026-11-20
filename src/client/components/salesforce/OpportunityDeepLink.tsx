// Deep link: any page with ?openOpportunity=<crm id>[&name=<label>] opens the
// activities drawer for that Opportunity on the active team (v1.449+). The SE
// Effort card in CriteriaIQ links here, so a click lands on the activities
// behind the hours it shows. What the drawer lists is decided server-side by
// GET /api/activities/by-sf, exactly as when it is opened from a dashboard.
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTeam } from '../../store/team.js'
import { SfActivitiesModal } from './SfActivitiesModal.js'

const CRM_ID_RX = /^[A-Za-z0-9]{1,40}$/
const SF_18_RX = /^[A-Za-z0-9]{18}$/
const MAX_NAME = 200

interface Target { id: string; name: string }

export function OpportunityDeepLink() {
  const location = useLocation()
  const { activeTeam, teams } = useTeam()
  const [target, setTarget] = useState<Target | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const raw = params.get('openOpportunity')
    if (raw === null) return
    const id = raw.trim()
    if (CRM_ID_RX.test(id)) {
      const name = (params.get('name') ?? '').trim().slice(0, MAX_NAME)
      setTarget({ id, name: name || id })
    }
    params.delete('openOpportunity')
    params.delete('name')
    const q = params.toString()
    window.history.replaceState({}, '', `${location.pathname}${q ? '?' + q : ''}${location.hash}`)
  }, [location.search, location.pathname, location.hash])

  const teamId = activeTeam?.id ?? teams[0]?.id
  if (!target || !teamId) return null
  // An 18-char Salesforce id may have been saved in its 15-char form too.
  const extraWhatIds = SF_18_RX.test(target.id) ? [target.id.slice(0, 15)] : undefined
  return (
    <SfActivitiesModal
      open
      onClose={() => setTarget(null)}
      teamId={teamId}
      whatId={target.id}
      whatType="Opportunity"
      whatName={target.name}
      extraWhatIds={extraWhatIds}
    />
  )
}
