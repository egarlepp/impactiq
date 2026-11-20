import { describe, it, expect } from 'vitest'
import { mergeProfileSections, parseCustomSections, resolveSectionBase, type AiNoteCustomSection } from '../../../shared/aiNotes.js'
import { decideAiNoteRead } from './access.js'
import { aiNoteJsonSchema, chunkTranscripts, parseAiNoteAnswer, parseCitation, parseOffset, systemPrompt, transcriptText, type PromptCall } from './prompt.js'

const call = (label: string, callId: string, lines: Array<[string | null, string]>): PromptCall => ({
  label,
  callId,
  title: 'Acme demo',
  startedAt: new Date('2026-10-28T15:00:00Z'),
  parties: [{ name: 'Dana Lee', email: 'dana@example.com', title: null, affiliation: 'internal', speakerId: 's1', gongUserId: null }],
  monologues: lines.map(([topic, text], i) => ({ speakerId: 's1', topic, sentences: [{ start: i * 60_000, text }] })),
})

describe('AI Notes prompt', () => {
  it('reads timestamps and citations back into ids', () => {
    expect(parseOffset('12:03')).toBe(723_000)
    expect(parseOffset('1:02:03')).toBe(3_723_000)
    expect(parseOffset('12:75')).toBeNull()
    const calls = new Map([['C1', '777']])
    const notes = new Map([['N1', 'note-1']])
    expect(parseCitation('C1@12:03', calls, notes)).toEqual({ kind: 'transcript', callId: '777', startMs: 723_000 })
    expect(parseCitation('[c1 00:10]', calls, notes)).toEqual({ kind: 'transcript', callId: '777', startMs: 10_000 })
    expect(parseCitation('N1', calls, notes)).toEqual({ kind: 'note', noteId: 'note-1' })
    expect(parseCitation('C9@00:10', calls, notes)).toBeNull()
    expect(parseCitation('N7', calls, notes)).toBeNull()
  })

  it('writes speakers and timestamps into the transcript', () => {
    expect(transcriptText([call('C1', '777', [[null, 'Hello there']])])).toContain('[C1 00:00] Dana Lee (internal): Hello there')
  })

  it('keeps only items for asked sections and drops bad ones', () => {
    const answer = JSON.stringify({
      items: [
        { section: 'summary', text: 'Acme wants SSO.', verdict: null, owner: null, meddpicc: null, cites: ['C1@00:00', 'N1', 'X'] },
        { section: 'summary', text: 'acme wants sso.', verdict: null, owner: null, meddpicc: null, cites: [] },
        { section: 'checked', text: 'Okta vs Entra', verdict: 'differs', owner: null, meddpicc: null, cites: [] },
        { section: 'checked', text: 'No verdict', verdict: null, owner: null, meddpicc: null, cites: [] },
        { section: 'risks', text: 'Not asked for', verdict: null, owner: null, meddpicc: null, cites: [] },
        { section: 'meddpicc', text: 'CFO signs', verdict: null, owner: null, meddpicc: 'economic_buyer', cites: [] },
        { section: 'next_steps', text: 'Send docs', verdict: 'confirmed', owner: ' Dana ', meddpicc: 'metrics', cites: [] },
        { section: 'summary', text: '   ', verdict: null, owner: null, meddpicc: null, cites: [] },
      ],
    })
    const items = parseAiNoteAnswer(answer, {
      sections: ['summary', 'checked', 'meddpicc', 'next_steps'],
      hasTranscript: true,
      calls: new Map([['C1', '777']]),
      notes: new Map([['N1', 'note-1']]),
    })
    expect(items).toEqual([
      { section: 'summary', sectionMeta: null, text: 'Acme wants SSO.', verdict: null, ownerName: null, meddpiccKey: null, citations: [{ kind: 'transcript', callId: '777', startMs: 0 }, { kind: 'note', noteId: 'note-1' }] },
      { section: 'checked', sectionMeta: null, text: 'Okta vs Entra', verdict: 'differs', ownerName: null, meddpiccKey: null, citations: [] },
      { section: 'meddpicc', sectionMeta: null, text: 'CFO signs', verdict: null, ownerName: null, meddpiccKey: 'economic_buyer', citations: [] },
      { section: 'next_steps', sectionMeta: null, text: 'Send docs', verdict: null, ownerName: 'Dana', meddpiccKey: null, citations: [] },
    ])
  })

  it('writes and reads back custom (profile) sections', () => {
    const custom: AiNoteCustomSection = { key: 'c_tech0001', name: 'Technical requirements', instructions: 'List each\n requirement.', icon: 'Cpu', color: '#0ea5e9' }
    const prompt = systemPrompt(['summary'], false, [custom])
    expect(prompt).toContain('- c_tech0001: "Technical requirements". List each requirement.')
    const schema = aiNoteJsonSchema([custom.key]) as { properties: { items: { items: { properties: { section: { enum: string[] } } } } } }
    expect(schema.properties.items.items.properties.section.enum).toContain('c_tech0001')
    const answer = JSON.stringify({
      items: [
        { section: 'c_tech0001', text: 'Needs SAML.', verdict: 'confirmed', owner: 'Dana', meddpicc: 'metrics', cites: ['N1'] },
        { section: 'c_unknown01', text: 'Not a section here', verdict: null, owner: null, meddpicc: null, cites: [] },
      ],
    })
    expect(parseAiNoteAnswer(answer, { sections: ['summary'], customSections: [custom], hasTranscript: false, calls: new Map(), notes: new Map([['N1', 'n1']]) })).toEqual([
      { section: 'c_tech0001', sectionMeta: { name: 'Technical requirements', icon: 'Cpu', color: '#0ea5e9' }, text: 'Needs SAML.', verdict: null, ownerName: null, meddpiccKey: null, citations: [{ kind: 'note', noteId: 'n1' }] },
    ])
  })

  it('adds profile sections to the person\'s own, each once', () => {
    const a: AiNoteCustomSection = { key: 'c_aaaaaaaa', name: 'A', instructions: 'a', icon: null, color: null }
    const b: AiNoteCustomSection = { key: 'c_bbbbbbbb', name: 'B', instructions: 'b', icon: null, color: null }
    expect(mergeProfileSections({ sections: ['summary'], customSections: [], source: 'personal' }, [
      { sections: ['risks', 'summary'], customSections: [a] },
      { sections: ['meddpicc'], customSections: [a, b] },
    ])).toEqual({ sections: ['summary', 'risks', 'meddpicc'], customSections: [a, b] })
    expect(parseCustomSections([a, { key: 'bad', name: 'x', instructions: 'y' }, a, 'junk'])).toEqual([a])
  })

  it('never writes "checked" without a transcript', () => {
    const answer = JSON.stringify({ items: [{ section: 'checked', text: 'x', verdict: 'confirmed', owner: null, meddpicc: null, cites: [] }] })
    expect(parseAiNoteAnswer(answer, { sections: ['checked'], hasTranscript: false, calls: new Map(), notes: new Map() })).toEqual([])
    expect(systemPrompt(['summary', 'checked'], false)).not.toContain('checked:')
    expect(systemPrompt(['summary', 'checked'], true)).toContain('checked:')
  })

  it('answers null for something that is not the expected JSON', () => {
    expect(parseAiNoteAnswer('not json', { sections: ['summary'], hasTranscript: false, calls: new Map(), notes: new Map() })).toBeNull()
    expect(parseAiNoteAnswer('{"foo":1}', { sections: ['summary'], hasTranscript: false, calls: new Map(), notes: new Map() })).toBeNull()
    expect(parseAiNoteAnswer('```json\n{"items":[]}\n```', { sections: ['summary'], hasTranscript: false, calls: new Map(), notes: new Map() })).toEqual([])
  })

  it('splits long calls by topic, within the size and chunk caps', () => {
    const long = 'x'.repeat(300)
    const lines: Array<[string | null, string]> = []
    for (let i = 0; i < 40; i++) lines.push([`topic-${Math.floor(i / 4)}`, long])
    const { chunks, truncated } = chunkTranscripts([call('C1', '777', lines)], 2_000, 100)
    expect(truncated).toBe(false)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2_000)
      expect(c.startsWith('### Call C1')).toBe(true)
    }
    expect(chunks.join('\n').split('[C1 ').length - 1).toBe(40)
    const capped = chunkTranscripts([call('C1', '777', lines)], 2_000, 2)
    expect(capped.chunks).toHaveLength(2)
    expect(capped.truncated).toBe(true)
  })
})

describe('AI Notes sections and access', () => {
  const custom: AiNoteCustomSection = { key: 'c_dddddddd', name: 'D', instructions: 'd', icon: null, color: null }
  const extra: AiNoteCustomSection = { key: 'c_eeeeeeee', name: 'E', instructions: 'e', icon: null, color: null }

  it('uses the person\'s sections, else the team\'s Default profile, else all', () => {
    expect(resolveSectionBase(['risks', 'summary', 'bogus'], { sections: ['summary'], customSections: [custom] }))
      .toEqual({ sections: ['summary', 'risks'], customSections: [], source: 'personal' })
    expect(resolveSectionBase(null, { sections: ['meddpicc'], customSections: [custom] }))
      .toEqual({ sections: ['meddpicc'], customSections: [custom], source: 'team_default' })
    expect(resolveSectionBase([], { sections: [], customSections: [custom] }))
      .toEqual({ sections: [], customSections: [custom], source: 'team_default' })
    expect(resolveSectionBase([], { sections: [], customSections: [] }))
      .toEqual({ sections: ['summary', 'checked', 'next_steps', 'risks', 'meddpicc'], customSections: [], source: 'builtin' })
    expect(resolveSectionBase(null, null).source).toBe('builtin')
  })

  it('lets a Replace profile drop the team default, never a person\'s own sections', () => {
    const teamBase = { sections: ['summary', 'risks'] as const, customSections: [custom], source: 'team_default' as const }
    const replace = { sections: ['next_steps'], customSections: [extra], combineMode: 'replace' as const }
    const add = { sections: ['meddpicc'], customSections: [], combineMode: 'add' as const }
    expect(mergeProfileSections({ ...teamBase, sections: [...teamBase.sections] }, [add]))
      .toEqual({ sections: ['summary', 'risks', 'meddpicc'], customSections: [custom] })
    expect(mergeProfileSections({ ...teamBase, sections: [...teamBase.sections] }, [add, replace]))
      .toEqual({ sections: ['next_steps', 'meddpicc'], customSections: [extra] })
    expect(mergeProfileSections({ sections: ['summary', 'checked', 'next_steps', 'risks', 'meddpicc'], customSections: [], source: 'builtin' }, [replace]))
      .toEqual({ sections: ['next_steps'], customSections: [extra] })
    expect(mergeProfileSections({ sections: ['summary'], customSections: [], source: 'personal' }, [replace]))
      .toEqual({ sections: ['summary', 'next_steps'], customSections: [extra] })
  })

  it('keeps an AI Note written from a private note to the owner and App Admins', () => {
    expect(decideAiNoteRead({ isAppAdmin: false, isOwner: true, usedPrivateNotes: true, transcriptRuleAllows: false })).toBe(true)
    expect(decideAiNoteRead({ isAppAdmin: true, isOwner: false, usedPrivateNotes: true, transcriptRuleAllows: false })).toBe(true)
    expect(decideAiNoteRead({ isAppAdmin: false, isOwner: false, usedPrivateNotes: true, transcriptRuleAllows: true })).toBe(false)
    expect(decideAiNoteRead({ isAppAdmin: false, isOwner: false, usedPrivateNotes: false, transcriptRuleAllows: true })).toBe(true)
    expect(decideAiNoteRead({ isAppAdmin: false, isOwner: false, usedPrivateNotes: false, transcriptRuleAllows: false })).toBe(false)
  })
})
