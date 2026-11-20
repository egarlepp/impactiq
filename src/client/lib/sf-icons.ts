import { Briefcase, Building2, Megaphone, UserPlus, User, Target, Cloud, CirclePlay, Forklift, Handshake, type LucideIcon } from 'lucide-react'

// Canonical icon vocabulary for Salesforce object types across the
// app. Extracted so activity card, notes drawer, my-notes list, and
// AI suggestion cards agree on the icon for a given SF type.
export function sfIcon(type: string | null | undefined): LucideIcon | null {
  switch (type) {
    case 'Opportunity': return Briefcase
    case 'Account': return Building2
    case 'Campaign': return Megaphone
    case 'Lead': return UserPlus
    case 'Contact': return User
    default: return null
  }
}

// v1.148.0: icon per Evaluation_Type__c value, keyed by the SF picklist
// label. `Target` is also the app-wide default "Project" icon shown
// before a type is known (ProjectMatchChip, SfRelatedChip), so a POC
// evaluation renders unchanged — only the other types get a more
// specific icon once the type is fetched/known.
export function evalTypeIcon(type: string | null | undefined): LucideIcon | null {
  switch (type) {
    case 'POC': return Target
    case 'Virtual Lab': return Cloud
    case 'RTU': return CirclePlay
    case 'Trial': return Forklift
    case 'Partner NFR':
    case 'Partner Lead': return Handshake
    default: return null
  }
}
