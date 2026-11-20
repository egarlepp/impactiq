import { useTranslation } from 'react-i18next'
import { Label } from '../ui/label.js'
import { Select } from '../ui/select.js'

export type ApplyScope = 'this' | 'all'

export function ApplyScopeSelect({ value, onChange }: { value: ApplyScope; onChange: (v: ApplyScope) => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1">
      <Label>{t('admin.apply_scope.label')}</Label>
      <Select value={value} onChange={(e) => onChange(e.target.value as ApplyScope)}>
        <option value="this">{t('admin.apply_scope.this_team')}</option>
        <option value="all">{t('admin.apply_scope.all_teams')}</option>
      </Select>
    </div>
  )
}
