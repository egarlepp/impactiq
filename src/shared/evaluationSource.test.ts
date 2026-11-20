import { describe, it, expect } from 'vitest'
import { CRITERIAIQ_RELATED_TYPE, crmProjectsActive, evaluationSourceChangeAllowed, isBlockedProjectLink, isWrongSourceProjectLink, normalizeEvaluationSourceSetting, projectsEnabled, secondaryAllowed } from './evaluationSource.js'

describe('normalizeEvaluationSourceSetting', () => {
  it('defaults to the CRM object with no secondary', () => {
    expect(normalizeEvaluationSourceSetting(undefined)).toEqual({ primary: 'crm', dataSource: 'crm', criteriaiqSecondary: false })
    expect(normalizeEvaluationSourceSetting({ primary: 'bogus' })).toEqual({ primary: 'crm', dataSource: 'crm', criteriaiqSecondary: false })
  })

  it('keeps a stored data source and derives one when missing', () => {
    expect(normalizeEvaluationSourceSetting({ primary: 'off', dataSource: 'criteriaiq' }).dataSource).toBe('criteriaiq')
    expect(normalizeEvaluationSourceSetting({ primary: 'off' }).dataSource).toBe('crm')
    expect(normalizeEvaluationSourceSetting({ primary: 'criteriaiq' }).dataSource).toBe('criteriaiq')
  })

  it('drops the secondary unless the CRM object is primary', () => {
    expect(normalizeEvaluationSourceSetting({ primary: 'crm', criteriaiqSecondary: true }).criteriaiqSecondary).toBe(true)
    expect(normalizeEvaluationSourceSetting({ primary: 'criteriaiq', criteriaiqSecondary: true }).criteriaiqSecondary).toBe(false)
    expect(normalizeEvaluationSourceSetting({ primary: 'off', criteriaiqSecondary: true }).criteriaiqSecondary).toBe(false)
    expect(secondaryAllowed('crm')).toBe(true)
  })
})

describe('evaluationSourceChangeAllowed', () => {
  const crm = normalizeEvaluationSourceSetting({ primary: 'crm' })
  it('allows any change with no Project links', () => {
    expect(evaluationSourceChangeAllowed(crm, 'criteriaiq', false)).toBe(true)
  })
  it('with links, allows only the links\' own source or off', () => {
    expect(evaluationSourceChangeAllowed(crm, 'criteriaiq', true)).toBe(false)
    expect(evaluationSourceChangeAllowed(crm, 'off', true)).toBe(true)
    const off = normalizeEvaluationSourceSetting({ primary: 'off', dataSource: 'crm' })
    expect(evaluationSourceChangeAllowed(off, 'crm', true)).toBe(true)
    expect(evaluationSourceChangeAllowed(off, 'criteriaiq', true)).toBe(false)
  })
})

describe('Projects off', () => {
  it('only Off turns Project features off', () => {
    expect(projectsEnabled('crm')).toBe(true)
    expect(projectsEnabled('criteriaiq')).toBe(true)
    expect(projectsEnabled('off')).toBe(false)
  })

  it('never blocks a save while Projects are on', () => {
    expect(isBlockedProjectLink('crm', { crmRelatedId: 'a0X2' }, { crmRelatedId: 'a0X1' })).toBe(false)
  })

  it('with Projects off, blocks adding or changing a link', () => {
    expect(isBlockedProjectLink('off', { crmRelatedId: 'a0X1' })).toBe(true)
    expect(isBlockedProjectLink('off', { crmRelatedId: 'a0X1' }, { crmRelatedId: null })).toBe(true)
    expect(isBlockedProjectLink('off', { crmRelatedId: 'a0X2' }, { crmRelatedId: 'a0X1' })).toBe(true)
  })

  it('with Projects off, still allows keeping, clearing or not sending a link', () => {
    expect(isBlockedProjectLink('off', { crmRelatedId: 'a0X1' }, { crmRelatedId: 'a0X1' })).toBe(false)
    expect(isBlockedProjectLink('off', { crmRelatedId: null }, { crmRelatedId: 'a0X1' })).toBe(false)
    expect(isBlockedProjectLink('off', {}, { crmRelatedId: 'a0X1' })).toBe(false)
  })
})

describe('isWrongSourceProjectLink', () => {
  const ciq = { crmRelatedType: CRITERIAIQ_RELATED_TYPE, crmRelatedId: '42' }
  const sf = { crmRelatedType: 'Evaluations__c', crmRelatedId: 'a0X5e000001AbCdEAK' }

  it('with CriteriaIQ as primary, accepts only CriteriaIQ project ids', () => {
    expect(isWrongSourceProjectLink('criteriaiq', ciq)).toBe(false)
    expect(isWrongSourceProjectLink('criteriaiq', sf)).toBe(true)
    expect(isWrongSourceProjectLink('criteriaiq', { crmRelatedType: CRITERIAIQ_RELATED_TYPE, crmRelatedId: 'abc' })).toBe(true)
    expect(isWrongSourceProjectLink('criteriaiq', { crmRelatedType: CRITERIAIQ_RELATED_TYPE, crmRelatedId: '0' })).toBe(true)
  })

  it('with the CRM as primary, refuses a CriteriaIQ project id', () => {
    expect(isWrongSourceProjectLink('crm', sf)).toBe(false)
    expect(isWrongSourceProjectLink('crm', ciq)).toBe(true)
  })

  it('always allows keeping or clearing a link, and leaves Off to isBlockedProjectLink', () => {
    expect(isWrongSourceProjectLink('criteriaiq', sf, { crmRelatedId: sf.crmRelatedId })).toBe(false)
    expect(isWrongSourceProjectLink('criteriaiq', { crmRelatedId: null })).toBe(false)
    expect(isWrongSourceProjectLink('off', ciq)).toBe(false)
  })

  it('treats only the CRM primary as CRM Projects', () => {
    expect(crmProjectsActive('crm')).toBe(true)
    expect(crmProjectsActive('criteriaiq')).toBe(false)
    expect(crmProjectsActive('off')).toBe(false)
  })
})
