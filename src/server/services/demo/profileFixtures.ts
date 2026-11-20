import { db } from '../../db/index.js'
import { aiNoteProfiles } from '../../../../drizzle/schema.js'
import {
  AI_NOTE_SECTIONS,
  type AiNoteCustomSection,
  type AiNoteProfileCombineMode,
  type AiNoteSection,
} from '../../../shared/aiNotes.js'

// Demo AI Note Settings Profiles (v1.473.0): the demo team's starred Default
// profile plus one profile per sample AI Assessment (assessmentFixtures.ts),
// two that add to the default and one that replaces it. The custom sections
// below also appear as items in the demo AI Notes (gongFixtures.ts), so the
// AI Notes tab shows what each profile adds. They go with the demo team
// (ai_note_profiles.team_id cascades).

export const DEMO_CUSTOM_SECTIONS = {
  pain: {
    key: 'c_demopain',
    name: 'Pain and impact',
    instructions: 'The business problem the customer described and what it costs them, in their own words and numbers.',
    icon: 'Flame',
    color: '#DC2626',
  },
  decision: {
    key: 'c_demodecide',
    name: 'Decision path',
    instructions: 'Who decides, who signs, the steps before signature and any dates given.',
    icon: 'Route',
    color: '#2563EB',
  },
  objections: {
    key: 'c_demoobject',
    name: 'Objections raised',
    instructions: 'Concerns or pushback the customer raised during the demo, and how each was answered.',
    icon: 'ShieldAlert',
    color: '#D97706',
  },
  criteria: {
    key: 'c_democriteria',
    name: 'Success criteria status',
    instructions: 'Each agreed success criterion with its status: met, open or at risk, and what it is waiting on.',
    icon: 'ListChecks',
    color: '#059669',
  },
} as const satisfies Record<string, AiNoteCustomSection>

export type DemoCustomSectionKey = typeof DEMO_CUSTOM_SECTIONS[keyof typeof DEMO_CUSTOM_SECTIONS]['key']

interface ProfileFixture {
  name: string
  description: string
  icon: string
  iconColor: string
  isDefault: boolean
  combineMode: AiNoteProfileCombineMode
  sections: AiNoteSection[]
  customSections: AiNoteCustomSection[]
  // The sample AI Assessment (by name) that uses this profile.
  rubric: string | null
}

export const DEMO_PROFILES: ProfileFixture[] = [
  {
    name: 'Default',
    description: 'The sections everyone on the team gets unless they picked their own in My Settings.',
    icon: 'NotebookPen',
    iconColor: '#4B5563',
    isDefault: true,
    combineMode: 'add',
    sections: [...AI_NOTE_SECTIONS],
    customSections: [],
    rubric: null,
  },
  {
    name: 'Discovery Deep Dive',
    description: 'Adds the pain and the decision path to discovery calls, for the Discovery Quality assessment.',
    icon: 'Search',
    iconColor: '#2563EB',
    isDefault: false,
    combineMode: 'add',
    sections: [],
    customSections: [DEMO_CUSTOM_SECTIONS.pain, DEMO_CUSTOM_SECTIONS.decision],
    rubric: 'Discovery Quality',
  },
  {
    name: 'Demo Follow-up',
    description: 'Adds the objections raised during a demo, for the Demo Effectiveness assessment.',
    icon: 'Presentation',
    iconColor: '#7C3AED',
    isDefault: false,
    combineMode: 'add',
    sections: [],
    customSections: [DEMO_CUSTOM_SECTIONS.objections],
    rubric: 'Demo Effectiveness',
  },
  {
    name: 'Evaluation Checkpoint',
    description: 'Replaces the default with a shorter set built around success criteria (no MEDDPICC), for the Evaluation Progress assessment.',
    icon: 'FlaskConical',
    iconColor: '#059669',
    isDefault: false,
    combineMode: 'replace',
    sections: ['summary', 'checked', 'next_steps', 'risks'],
    customSections: [DEMO_CUSTOM_SECTIONS.criteria],
    rubric: 'Evaluation Progress',
  },
]

/**
 * Creates the demo team's Settings Profiles. Returns each sample assessment's
 * profile id by assessment name, for seedDemoAssessments().
 */
export async function seedDemoNoteProfiles(opts: { teamId: string; adminUserId: string }): Promise<Map<string, string>> {
  const byRubric = new Map<string, string>()
  for (const p of DEMO_PROFILES) {
    const [row] = await db.insert(aiNoteProfiles).values({
      teamId: opts.teamId,
      name: p.name,
      description: p.description,
      icon: p.icon,
      iconColor: p.iconColor,
      sections: p.sections,
      customSections: p.customSections,
      isDefault: p.isDefault,
      combineMode: p.combineMode,
      createdBy: opts.adminUserId,
      updatedBy: opts.adminUserId,
    }).returning({ id: aiNoteProfiles.id })
    if (row && p.rubric) byRubric.set(p.rubric, row.id)
  }
  return byRubric
}
