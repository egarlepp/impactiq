import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Package, Plus, Pencil, Trash2, X, Save } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Badge } from '../ui/badge.js'
import { Spinner } from '../ui/spinner.js'
import { TeamAssignmentPicker } from './TeamAssignmentPicker.js'

interface Product {
  id: string
  name: string
  space: string | null
  abbreviation: string | null
  isActive: boolean
  teamIds: string[]
  iconDataUrl: string | null
}

interface FormState {
  name: string
  space: string
  abbreviation: string
  isActive: boolean
  teamIds: string[]
  iconDataUrl: string | null
}

const empty: FormState = { name: '', space: '', abbreviation: '', isActive: true, teamIds: [], iconDataUrl: null }

export function ProductsConfig() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createForm, setCreateForm] = useState<FormState>(empty)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<FormState>(empty)

  async function reload() {
    setLoading(true)
    const res = await api.get<Product[]>('/api/admin/products')
    setRows(res.data ?? [])
    setLoading(false)
  }
  useEffect(() => { void reload() }, [])

  async function submitCreate() {
    if (!createForm.name.trim()) return
    setSaving('create')
    await api.post('/api/admin/products', {
      name: createForm.name.trim(),
      space: createForm.space.trim() || undefined,
      abbreviation: createForm.abbreviation.trim() || undefined,
      isActive: createForm.isActive,
      teamIds: createForm.teamIds,
      iconDataUrl: createForm.iconDataUrl,
    })
    setSaving(null)
    setCreating(false)
    setCreateForm(empty)
    void reload()
  }

  function startEdit(p: Product) {
    setEditingId(p.id)
    setEditForm({
      name: p.name,
      space: p.space ?? '',
      abbreviation: p.abbreviation ?? '',
      isActive: p.isActive,
      teamIds: p.teamIds,
      iconDataUrl: p.iconDataUrl,
    })
  }

  async function submitEdit() {
    if (!editingId || !editForm.name.trim()) return
    setSaving(editingId)
    await api.patch(`/api/admin/products/${editingId}`, {
      name: editForm.name.trim(),
      space: editForm.space.trim() || null,
      abbreviation: editForm.abbreviation.trim() || null,
      isActive: editForm.isActive,
      teamIds: editForm.teamIds,
      iconDataUrl: editForm.iconDataUrl,
    })
    setSaving(null)
    setEditingId(null)
    void reload()
  }

  async function remove(p: Product) {
    if (!window.confirm(t('admin.products.delete_confirm', { name: p.name }))) return
    setSaving(p.id)
    await api.delete(`/api/admin/products/${p.id}`)
    setSaving(null)
    void reload()
  }

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <Package className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          <span>{rows.length} {t('admin.products.count')}</span>
        </p>
        {!creating && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            {t('admin.products.add')}
          </Button>
        )}
      </div>

      {creating && (
        <ProductForm
          title={t('admin.products.add')}
          form={createForm}
          setForm={setCreateForm}
          onSubmit={submitCreate}
          onCancel={() => { setCreating(false); setCreateForm(empty) }}
          saving={saving === 'create'}
        />
      )}

      <div className="flex flex-col gap-1 rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        {rows.map((p) => editingId === p.id ? (
          <ProductForm
            key={p.id}
            title={t('common.edit')}
            form={editForm}
            setForm={setEditForm}
            onSubmit={submitEdit}
            onCancel={() => setEditingId(null)}
            saving={saving === p.id}
          />
        ) : (
          <div key={p.id} className="grid grid-cols-[1fr_140px_80px_120px_80px] items-center gap-3 px-3 py-2">
            <div className="flex items-center gap-2">
              {p.iconDataUrl && (
                <img src={p.iconDataUrl} alt="" className="h-6 w-6 shrink-0 rounded object-contain border border-gray-200 dark:border-gray-700" />
              )}
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.name}</p>
                {p.space && <p className="text-[11px] text-gray-500 dark:text-gray-400">{p.space}</p>}
              </div>
            </div>
            <span className="text-xs text-gray-600 dark:text-gray-300">{p.abbreviation ?? '—'}</span>
            <Badge variant={p.isActive ? 'success' : 'outline'}>{p.isActive ? t('admin.picklist.active') : t('admin.picklist.inactive')}</Badge>
            <span className="text-xs text-gray-500 dark:text-gray-400">{p.teamIds.length} {t('admin.products.teams')}</span>
            <div className="flex items-center gap-1">
              <button onClick={() => startEdit(p)} className="rounded p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><Pencil className="h-3.5 w-3.5" /></button>
              <button onClick={() => remove(p)} disabled={saving === p.id} className="rounded p-1.5 text-gray-400 hover:text-red-600 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        ))}
        {rows.length === 0 && !creating && (
          <p className="py-6 text-center text-sm text-gray-400 dark:text-gray-500">{t('admin.products.empty')}</p>
        )}
      </div>
    </div>
  )
}

function ProductForm({
  title, form, setForm, onSubmit, onCancel, saving,
}: {
  title: string
  form: FormState
  setForm: (next: FormState) => void
  onSubmit: () => void
  onCancel: () => void
  saving: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">{title}</p>
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label>{t('admin.products.name')}</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        </div>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.products.space')}</Label>
          <Input value={form.space} onChange={(e) => setForm({ ...form, space: e.target.value })} placeholder={t('admin.products.space_placeholder')} />
        </div>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.products.abbreviation')}</Label>
          <Input value={form.abbreviation} onChange={(e) => setForm({ ...form, abbreviation: e.target.value })} placeholder="Abbr" />
        </div>
      </div>
      <div className="mt-3">
        <TeamAssignmentPicker selectedIds={form.teamIds} onChange={(ids) => setForm({ ...form, teamIds: ids })} />
      </div>
      <div className="mt-3 flex flex-col gap-1">
        <Label>{t('admin.products.icon_label', 'Product icon (PNG / SVG / BMP, max 1 MB)')}</Label>
        <ProductIconUpload
          value={form.iconDataUrl}
          onChange={(next) => setForm({ ...form, iconDataUrl: next })}
        />
      </div>
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs">
        <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} className="h-4 w-4" />
        <span>{t('admin.products.active')}</span>
      </label>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={onSubmit} disabled={saving || !form.name.trim()}>
          {saving ? <Spinner className="mr-1 h-3 w-3" /> : <Save className="mr-1 h-3.5 w-3.5" />}
          {t('common.save')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}><X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}</Button>
      </div>
    </div>
  )
}

// v1.93.0: PNG / SVG / BMP up to 1 MB. Client-side type + size check —
// server re-validates on save. Data URL stored inline in `products.icon_data_url`.
function ProductIconUpload({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [err, setErr] = useState<string | null>(null)
  const ALLOWED = new Set(['image/png', 'image/svg+xml', 'image/bmp', 'image/x-ms-bmp'])
  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setErr(null)
    if (!ALLOWED.has(f.type)) { setErr('Unsupported file type. Use PNG, SVG, or BMP.'); return }
    if (f.size > 1024 * 1024) { setErr('File too large (max 1 MB).'); return }
    const reader = new FileReader()
    reader.onload = () => { if (typeof reader.result === 'string') onChange(reader.result) }
    reader.readAsDataURL(f)
  }
  return (
    <div className="flex items-center gap-3">
      {value ? (
        <img src={value} alt="" className="h-10 w-10 rounded object-contain border border-gray-200 dark:border-gray-700" />
      ) : (
        <div className="flex h-10 w-10 items-center justify-center rounded border border-dashed border-gray-300 text-gray-400 dark:border-gray-700">
          <Package className="h-5 w-5" />
        </div>
      )}
      <input type="file" accept="image/png,image/svg+xml,image/bmp" onChange={pick} className="text-xs" />
      {value && (
        <button type="button" onClick={() => onChange(null)} className="text-xs text-red-600 hover:underline dark:text-red-400">
          Remove
        </button>
      )}
      {err && <span className="text-xs text-red-600 dark:text-red-400">{err}</span>}
    </div>
  )
}
