// v1.376.0: default icon (lucide component name, same format IconPicker
// stores) and icon color for the ten seeded Activity Types. Used by the
// fresh-install seed (drizzle/seed.ts), new-team defaults
// (services/teams/defaults.ts) and Admin → Activity Types → Seed Default
// Content, which only fills these in where a type has none yet.
export const DEFAULT_ACTIVITY_TYPE_STYLES: Record<string, { icon: string; color: string }> = {
  'Demo': { icon: 'Presentation', color: '#4F46E5' },
  'Discovery': { icon: 'Search', color: '#0EA5E9' },
  'Enablement': { icon: 'GraduationCap', color: '#10B981' },
  'Eval Work': { icon: 'FlaskConical', color: '#7C3AED' },
  'Executive Briefing': { icon: 'Users', color: '#F59E0B' },
  'HealthCheck': { icon: 'Activity', color: '#3730A3' },
  'Marketing': { icon: 'Megaphone', color: '#DB2777' },
  'Meeting': { icon: 'MessageSquare', color: '#4B5563' },
  'RFx Work': { icon: 'FileText', color: '#F97316' },
  'Support': { icon: 'LifeBuoy', color: '#DC2626' },
}
