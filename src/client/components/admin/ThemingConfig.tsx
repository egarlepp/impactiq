import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Check, Pencil, X, Save, Upload, Image, Eye, Star, Copy, RotateCcw } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Badge } from '../ui/badge.js'
import { Spinner } from '../ui/spinner.js'
import { ColorPicker } from '../ui/color-picker.js'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { setBrandLogos, applyThemeColors, type ActiveThemeColors } from '../../store/branding.js'
import { PRESET_THEMES } from './theme-presets.js'
import { defaultLoginLogoSize, LOGIN_LOGO_SIZE_MIN, LOGIN_LOGO_SIZE_MAX } from '../../../shared/loginLogoSize.js'
import { trimImageDataUrl } from '../../lib/trimImage.js'

interface ThemeColors {
  primaryLight: string
  primaryDark: string
  surfaceLight: string
  surfaceDark: string
  linkLight: string
  linkDark: string
  pageBgLight: string
  pageBgDark: string
  borderLight: string
  borderDark: string
  headerLightFrom: string
  headerLightTo: string
  headerDarkFrom: string
  headerDarkTo: string
  sidebarBgLight: string
  sidebarBgDark: string
  // Gradient stops for the sidebar. When both from/to are set, the sidebar
  // renders as a top-to-bottom linear gradient. Older themes with only
  // sidebarBg* fill in from == to on load, so a legacy solid color still
  // renders identically until the admin edits the theme.
  sidebarBgLightFrom: string
  sidebarBgLightTo: string
  sidebarBgDarkFrom: string
  sidebarBgDarkTo: string
  sidebarHighlightLight: string
  sidebarHighlightDark: string
  sidebarTextLight: string
  sidebarTextDark: string
  sidebarActiveTextLight: string
  sidebarActiveTextDark: string
  sidebarTextMutedLight: string
  sidebarTextMutedDark: string
  sidebarBorderLight: string
  sidebarBorderDark: string
  sidebarPillBgLight: string
  sidebarPillBgDark: string
  // v1.36 additions — nav item hover + user pill name/subtitle + header text.
  navHoverBgLight: string
  navHoverBgDark: string
  userPillNameLight: string
  userPillNameDark: string
  userPillSubtitleLight: string
  userPillSubtitleDark: string
  headerTextLight: string
  headerTextDark: string
  // v1.358 — sidebar wordmark ("ImpactIQ") text color.
  appNameLight: string
  appNameDark: string
  // v1.380 — page title icon in the header bar (VectorIQ parity).
  pageHeaderIconLight: string
  pageHeaderIconDark: string
}

interface AppTheme {
  id: string
  name: string
  colors: ThemeColors
  isActive: boolean
  logoLight: string | null
  logoDark: string | null
  // v1.85.0: email template overrides. All optional; nulls fall back to
  // the system default in the renderer.
  emailTopBarColor: string | null
  emailBottomBarColor: string | null
  emailFooterLeftText: string | null
  emailHeaderLogoVariant: 'light' | 'dark' | null
  createdAt: string
}

const HARD_DEFAULTS: ThemeColors = {
  primaryLight: '#2563EB',
  primaryDark: '#3B82F6',
  surfaceLight: '#FFFFFF',
  surfaceDark: '#111827',
  linkLight: '#2563EB',
  linkDark: '#60A5FA',
  pageBgLight: '#F9FAFB',
  pageBgDark: '#030712',
  borderLight: '#E5E7EB',
  borderDark: '#374151',
  headerLightFrom: '#FFFFFF',
  headerLightTo: '#E8E6F8',
  headerDarkFrom: '#1A1536',
  headerDarkTo: '#1E3A6E',
  sidebarBgLight: '#FFFFFF',
  sidebarBgDark: '#111827',
  sidebarBgLightFrom: '#FFFFFF',
  sidebarBgLightTo: '#F1F5F9',
  sidebarBgDarkFrom: '#111827',
  sidebarBgDarkTo: '#1E293B',
  sidebarHighlightLight: '#EEF2FF',
  sidebarHighlightDark: '#1E3A6E',
  sidebarTextLight: '#4B5563',
  sidebarTextDark: '#D1D5DB',
  sidebarActiveTextLight: '#5851DB',
  sidebarActiveTextDark: '#93C5FD',
  sidebarTextMutedLight: '#9CA3AF',
  sidebarTextMutedDark: '#6B7280',
  sidebarBorderLight: '#E5E7EB',
  sidebarBorderDark: '#374151',
  sidebarPillBgLight: '#F9FAFB',
  sidebarPillBgDark: '#1F2937',
  navHoverBgLight: '#F3F4F6',
  navHoverBgDark: '#1F2937',
  userPillNameLight: '#111827',
  userPillNameDark: '#F3F4F6',
  userPillSubtitleLight: '#6B7280',
  userPillSubtitleDark: '#9CA3AF',
  headerTextLight: '#111827',
  headerTextDark: '#F3F4F6',
  appNameLight: '#2563EB',
  appNameDark: '#60A5FA',
  pageHeaderIconLight: '#2563EB',
  pageHeaderIconDark: '#60A5FA',
}

// Legacy themes may have a solid `sidebarBg*` but no gradient stops yet.
// When from/to are missing, mirror them from the solid value so the sidebar
// renders as a single-color "gradient" identical to what it looked like
// before this field existed.
function backfillSidebarGradient(c: Partial<ThemeColors>): Partial<ThemeColors> {
  const out = { ...c }
  if (!out.sidebarBgLightFrom && c.sidebarBgLight) out.sidebarBgLightFrom = c.sidebarBgLight
  if (!out.sidebarBgLightTo && c.sidebarBgLight) out.sidebarBgLightTo = c.sidebarBgLight
  if (!out.sidebarBgDarkFrom && c.sidebarBgDark) out.sidebarBgDarkFrom = c.sidebarBgDark
  if (!out.sidebarBgDarkTo && c.sidebarBgDark) out.sidebarBgDarkTo = c.sidebarBgDark
  return out
}

const COLOR_FIELDS: { key: keyof ThemeColors; labelKey: string }[] = [
  { key: 'primaryLight', labelKey: 'admin.themes.color_primary_light' },
  { key: 'primaryDark', labelKey: 'admin.themes.color_primary_dark' },
  { key: 'surfaceLight', labelKey: 'admin.themes.color_surface_light' },
  { key: 'surfaceDark', labelKey: 'admin.themes.color_surface_dark' },
  { key: 'linkLight', labelKey: 'admin.themes.color_link_light' },
  { key: 'linkDark', labelKey: 'admin.themes.color_link_dark' },
  { key: 'pageBgLight', labelKey: 'admin.themes.color_page_bg_light' },
  { key: 'pageBgDark', labelKey: 'admin.themes.color_page_bg_dark' },
  { key: 'borderLight', labelKey: 'admin.themes.color_border_light' },
  { key: 'borderDark', labelKey: 'admin.themes.color_border_dark' },
  { key: 'headerLightFrom', labelKey: 'admin.themes.color_header_light_from' },
  { key: 'headerLightTo', labelKey: 'admin.themes.color_header_light_to' },
  { key: 'headerDarkFrom', labelKey: 'admin.themes.color_header_dark_from' },
  { key: 'headerDarkTo', labelKey: 'admin.themes.color_header_dark_to' },
  { key: 'sidebarBgLightFrom', labelKey: 'admin.themes.color_sidebar_bg_light_from' },
  { key: 'sidebarBgLightTo', labelKey: 'admin.themes.color_sidebar_bg_light_to' },
  { key: 'sidebarBgDarkFrom', labelKey: 'admin.themes.color_sidebar_bg_dark_from' },
  { key: 'sidebarBgDarkTo', labelKey: 'admin.themes.color_sidebar_bg_dark_to' },
  { key: 'sidebarBgLight', labelKey: 'admin.themes.color_sidebar_bg_light' },
  { key: 'sidebarBgDark', labelKey: 'admin.themes.color_sidebar_bg_dark' },
  { key: 'sidebarHighlightLight', labelKey: 'admin.themes.color_sidebar_highlight_light' },
  { key: 'sidebarHighlightDark', labelKey: 'admin.themes.color_sidebar_highlight_dark' },
  { key: 'sidebarTextLight', labelKey: 'admin.themes.color_sidebar_text_light' },
  { key: 'sidebarTextDark', labelKey: 'admin.themes.color_sidebar_text_dark' },
  { key: 'sidebarActiveTextLight', labelKey: 'admin.themes.color_sidebar_active_text_light' },
  { key: 'sidebarActiveTextDark', labelKey: 'admin.themes.color_sidebar_active_text_dark' },
  { key: 'sidebarTextMutedLight', labelKey: 'admin.themes.color_sidebar_text_muted_light' },
  { key: 'sidebarTextMutedDark', labelKey: 'admin.themes.color_sidebar_text_muted_dark' },
  { key: 'sidebarBorderLight', labelKey: 'admin.themes.color_sidebar_border_light' },
  { key: 'sidebarBorderDark', labelKey: 'admin.themes.color_sidebar_border_dark' },
  { key: 'sidebarPillBgLight', labelKey: 'admin.themes.color_sidebar_pill_bg_light' },
  { key: 'sidebarPillBgDark', labelKey: 'admin.themes.color_sidebar_pill_bg_dark' },
  { key: 'navHoverBgLight', labelKey: 'admin.themes.color_nav_hover_bg_light' },
  { key: 'navHoverBgDark', labelKey: 'admin.themes.color_nav_hover_bg_dark' },
  { key: 'userPillNameLight', labelKey: 'admin.themes.color_user_pill_name_light' },
  { key: 'userPillNameDark', labelKey: 'admin.themes.color_user_pill_name_dark' },
  { key: 'userPillSubtitleLight', labelKey: 'admin.themes.color_user_pill_subtitle_light' },
  { key: 'userPillSubtitleDark', labelKey: 'admin.themes.color_user_pill_subtitle_dark' },
  { key: 'headerTextLight', labelKey: 'admin.themes.color_header_text_light' },
  { key: 'headerTextDark', labelKey: 'admin.themes.color_header_text_dark' },
  { key: 'pageHeaderIconLight', labelKey: 'admin.themes.color_page_header_icon_light' },
  { key: 'pageHeaderIconDark', labelKey: 'admin.themes.color_page_header_icon_dark' },
  { key: 'appNameLight', labelKey: 'admin.themes.color_app_name_light' },
  { key: 'appNameDark', labelKey: 'admin.themes.color_app_name_dark' },
]

const LOGO_ACCEPT = 'image/svg+xml,image/png,image/gif'
const LOGO_MAX_BYTES = 2 * 1024 * 1024

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function LogoUpload({
  label,
  value,
  onChange,
}: {
  label: string
  value: string | null
  onChange: (v: string | null) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > LOGO_MAX_BYTES) {
      alert('Logo must be 2 MB or smaller.')
      return
    }
    const dataUrl = await fileToDataUrl(file)
    onChange(dataUrl)
    e.target.value = ''
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        {value ? (
          <>
            <img src={value} alt="" className="h-8 w-8 rounded object-contain border border-gray-200 dark:border-gray-700" />
            <button
              type="button"
              onClick={() => onChange(null)}
              className="rounded p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
              title="Remove logo"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded border border-dashed border-gray-300 dark:border-gray-600">
            <Image className="h-4 w-4 text-gray-400" />
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5" />
          {value ? 'Replace' : 'Upload'}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={LOGO_ACCEPT}
          className="hidden"
          onChange={handleFile}
        />
        <span className="text-[10px] text-gray-400 dark:text-gray-500">SVG / PNG / GIF · max 2 MB</span>
      </div>
    </div>
  )
}

function PresetRow({
  onApply,
}: {
  onApply: (colors: Partial<ThemeColors>, name: string) => void
}) {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState<string | null>(null)
  return (
    <div className="mb-3 flex flex-col gap-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">
        {t('admin.themes.presets_title', 'Start from a preset')}
      </p>
      <div className="flex flex-wrap gap-2">
        {PRESET_THEMES.map((preset) => {
          const c = preset.colors
          const name = t(preset.labelKey)
          return (
            <button
              type="button"
              key={preset.key}
              onClick={() => {
                onApply(preset.colors as Partial<ThemeColors>, name)
                setLoaded(name)
                setTimeout(() => setLoaded(null), 1400)
              }}
              title={name}
              className="flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:border-blue-500 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:border-blue-400 dark:hover:bg-gray-800"
            >
              {/* Light-mode sidebar, dark-mode sidebar, button color */}
              <span className="flex items-center gap-0.5" aria-hidden="true">
                <span
                  className="h-5 w-3 rounded-sm border border-gray-300/60 dark:border-gray-600/60"
                  style={{ backgroundImage: `linear-gradient(to bottom, ${c.sidebarBgLightFrom}, ${c.sidebarBgLightTo})` }}
                />
                <span
                  className="h-5 w-3 rounded-sm border border-gray-300/60 dark:border-gray-600/60"
                  style={{ backgroundImage: `linear-gradient(to bottom, ${c.sidebarBgDarkFrom}, ${c.sidebarBgDarkTo})` }}
                />
                <span className="ml-0.5 h-3 w-3 rounded-full" style={{ backgroundColor: c.primaryLight }} />
              </span>
              {name}
            </button>
          )
        })}
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400">
        {t('admin.themes.preset_swatch_hint', 'Shown: light-mode sidebar, dark-mode sidebar, and the button color.')}
      </p>
      {loaded && (
        <p className="text-[10px] text-green-600 dark:text-green-400">
          {t('admin.themes.preset_loaded', 'Loaded {{name}}', { name: loaded })}
        </p>
      )}
    </div>
  )
}

// v1.85.0: email template settings + live iframe preview. Sits inside
// the theme edit form so admins tweak email look in the same panel as
// site branding. Preview posts current form state to
// /api/admin/themes/email-preview and drops the returned HTML into a
// sandboxed iframe (no scripts, no top-nav) so what admins see is byte-
// identical to what recipients get.
function EmailTemplatePanel({
  topBarColor, bottomBarColor, footerLeftText, headerLogoVariant,
  logoLight, logoDark,
  onChangeTop, onChangeBottom, onChangeFooter, onChangeLogoVariant,
}: {
  topBarColor: string | null
  bottomBarColor: string | null
  footerLeftText: string
  headerLogoVariant: 'light' | 'dark'
  logoLight: string | null
  logoDark: string | null
  onChangeTop: (v: string | null) => void
  onChangeBottom: (v: string | null) => void
  onChangeFooter: (v: string) => void
  onChangeLogoVariant: (v: 'light' | 'dark') => void
}) {
  const [previewHtml, setPreviewHtml] = useState<string>('')
  const [refreshing, setRefreshing] = useState(false)

  const chosenLogo = headerLogoVariant === 'dark' ? logoDark : logoLight

  const fetchPreview = useCallback(async () => {
    setRefreshing(true)
    const res = await api.post<{ html: string; text: string }>('/api/admin/themes/email-preview', {
      topBarColor: topBarColor || undefined,
      bottomBarColor: bottomBarColor || undefined,
      footerLeftText: footerLeftText.trim() || null,
      logoUrl: chosenLogo,
    })
    if (res.data?.html) setPreviewHtml(res.data.html)
    setRefreshing(false)
  }, [topBarColor, bottomBarColor, footerLeftText, chosenLogo])

  // v1.92.0: debounced auto-refresh so the iframe stays in lockstep with
  // the color pickers / footer text / logo variant without the user
  // clicking Refresh. Previously the preview was only fetched once on
  // mount, so the iframe was empty until the user clicked Preview OR
  // saved the theme (which unmounts and remounts). 400ms debounce so we
  // don't spam the endpoint on every color-picker drag frame.
  useEffect(() => {
    const id = window.setTimeout(() => { void fetchPreview() }, 400)
    return () => window.clearTimeout(id)
  }, [fetchPreview])

  return (
    <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">Email Template</p>
        <Button size="sm" variant="outline" onClick={() => void fetchPreview()}>
          {refreshing ? <Spinner className="mr-1 h-3 w-3" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
          Refresh preview
        </Button>
      </div>
      <PublicBaseUrlField />
      <SupportEmailField />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <ColorPicker
            label="Top bar color"
            value={topBarColor}
            onChange={(next) => onChangeTop(next)}
            onReset={() => onChangeTop(null)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <ColorPicker
            label="Bottom bar color"
            value={bottomBarColor}
            onChange={(next) => onChangeBottom(next)}
            onReset={() => onChangeBottom(null)}
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label>Footer left text</Label>
          <Input value={footerLeftText} onChange={(e) => onChangeFooter(e.target.value)} placeholder="e.g. Acme Corporation · Confidential" />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label>Header logo (right side)</Label>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className={cn('flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5', headerLogoVariant === 'light' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40' : 'border-gray-300 dark:border-gray-600')}>
              <input type="checkbox" checked={headerLogoVariant === 'light'} onChange={() => onChangeLogoVariant('light')} />
              {logoLight ? <img src={logoLight} alt="light" className="h-6 w-6 rounded object-contain" /> : <span className="h-6 w-6 rounded bg-gray-200 dark:bg-gray-700" />}
              <span>Light logo</span>
            </label>
            <label className={cn('flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5', headerLogoVariant === 'dark' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40' : 'border-gray-300 dark:border-gray-600')}>
              <input type="checkbox" checked={headerLogoVariant === 'dark'} onChange={() => onChangeLogoVariant('dark')} />
              {logoDark ? <img src={logoDark} alt="dark" className="h-6 w-6 rounded object-contain bg-gray-800" /> : <span className="h-6 w-6 rounded bg-gray-200 dark:bg-gray-700" />}
              <span>Dark logo</span>
            </label>
          </div>
        </div>
      </div>
      <div className="mt-3">
        <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Preview (as recipients will see it)</p>
        <iframe
          title="Email preview"
          srcDoc={previewHtml}
          sandbox=""
          className="h-[420px] w-full rounded border border-gray-300 bg-white dark:border-gray-600"
        />
      </div>
    </div>
  )
}

function ColorGrid({
  colors,
  onFieldChange,
}: {
  colors: ThemeColors
  onFieldChange: (key: keyof ThemeColors, next: string) => void
}) {
  const { t } = useTranslation()
  // Stable per-field onChange closures — ColorPicker's own onChange is
  // single-arg (no fieldKey), so ColorGrid must supply one closure per
  // field; rebuilding this map only when onFieldChange itself changes
  // (which it never does, see onColorsFieldChange's useCallback) keeps each
  // ColorPicker's memo comparison meaningful, same intent the original
  // ColorField's "stable field-change callback" comment described.
  const fieldHandlers = useMemo(
    () => Object.fromEntries(
      COLOR_FIELDS.map(({ key }) => [key, (next: string) => onFieldChange(key, next)]),
    ) as Record<keyof ThemeColors, (next: string) => void>,
    [onFieldChange],
  )
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {COLOR_FIELDS.map(({ key, labelKey }) => (
        <ColorPicker
          key={key}
          label={t(labelKey)}
          value={colors[key]}
          onChange={fieldHandlers[key]}
        />
      ))}
    </div>
  )
}

export function ThemingConfig() {
  const { t } = useTranslation()
  const [themes, setThemes] = useState<AppTheme[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [colors, setColors] = useState<ThemeColors>({ ...HARD_DEFAULTS })
  const [logoLight, setLogoLight] = useState<string | null>(null)
  const [logoDark, setLogoDark] = useState<string | null>(null)
  // v1.85.0: email template overrides. Null = use system default.
  const [emailTopBarColor, setEmailTopBarColor] = useState<string | null>(null)
  const [emailBottomBarColor, setEmailBottomBarColor] = useState<string | null>(null)
  const [emailFooterLeftText, setEmailFooterLeftText] = useState<string>('')
  const [emailHeaderLogoVariant, setEmailHeaderLogoVariant] = useState<'light' | 'dark'>('light')

  // Stable field-change callback so <ColorField> memo comparisons
  // short-circuit and only the field being dragged re-renders.
  const onColorsFieldChange = useCallback((key: keyof ThemeColors, next: string) => {
    setColors((prev) => ({ ...prev, [key]: next }))
  }, [])

  // Live preview is intentionally OFF. Applying ~30 CSS custom
  // properties on document.documentElement.style during a native
  // color-picker interaction — especially with the eyedropper
  // active — froze the whole browser tab on some setups even
  // with 100ms debouncing (v1.35.2 attempted that and users still
  // hit the freeze). Now the picker only updates the hex swatch
  // and the state; theme colors apply to the live UI only when
  // the user explicitly clicks Preview or Save.
  function previewColors() {
    applyThemeColors(colors as ActiveThemeColors)
  }

  async function reload() {
    setLoading(true)
    const themesRes = await api.get<AppTheme[]>('/api/admin/themes')
    setThemes(themesRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => { void reload() }, [])

  function openCreate() {
    setEditingId(null)
    setName('')
    // Seed from whichever theme is currently Active, if any, so a new theme
    // starts as an editable variant of the org's real branding rather than
    // generic placeholder blue — the same convenience the old "seed from the
    // default palette" behavior gave, just sourced from a real theme now.
    const active = themes.find((th) => th.isActive)
    setColors(active ? { ...HARD_DEFAULTS, ...backfillSidebarGradient(active.colors) } : { ...HARD_DEFAULTS })
    setLogoLight(active?.logoLight ?? null)
    setLogoDark(active?.logoDark ?? null)
    setEmailTopBarColor(null)
    setEmailBottomBarColor(null)
    setEmailFooterLeftText('')
    setEmailHeaderLogoVariant('light')
    setCreating(true)
  }

  function openEdit(theme: AppTheme) {
    setCreating(false)
    setEditingId(theme.id)
    setName(theme.name)
    // HARD_DEFAULTS first so fields added in later releases (and missing from
    // the saved JSON) inherit sensible defaults instead of rendering as
    // black #000000 swatches in the color picker.
    setColors({ ...HARD_DEFAULTS, ...backfillSidebarGradient(theme.colors) })
    setLogoLight(theme.logoLight ?? null)
    setLogoDark(theme.logoDark ?? null)
    setEmailTopBarColor(theme.emailTopBarColor ?? null)
    setEmailBottomBarColor(theme.emailBottomBarColor ?? null)
    setEmailFooterLeftText(theme.emailFooterLeftText ?? '')
    setEmailHeaderLogoVariant(theme.emailHeaderLogoVariant ?? 'light')
  }

  function cancelForm() {
    setCreating(false)
    setEditingId(null)
    // v1.89.0: canceling out of a theme edit/create should also revert any
    // previewed CSS custom properties back to the org-active theme so the
    // UI doesn't stay "stuck" on the previewed colors. Fetches /api/themes/active
    // fresh so the currently-active theme wins.
    restoreActiveTheme()
  }

  async function restoreActiveTheme() {
    try {
      const res = await fetch('/api/themes/active', { credentials: 'same-origin' })
      const json = await res.json() as { data?: { colors?: Record<string, string> | null } | null }
      if (json.data?.colors) applyThemeColors(json.data.colors as unknown as ActiveThemeColors)
      else applyThemeColors(HARD_DEFAULTS as ActiveThemeColors)
    } catch {
      applyThemeColors(HARD_DEFAULTS as ActiveThemeColors)
    }
  }

  const [formError, setFormError] = useState<string | null>(null)
  async function submitForm() {
    if (!name.trim()) return
    setFormError(null)
    // Merge with HARD_DEFAULTS so any required color field missing from the
    // current state (e.g. an older theme saved before a field existed)
    // still passes server-side Zod validation. Previously a missing field
    // returned 400 and the Save button hung because the client only
    // branched on res.data (a 400 has null data + error msg).
    const safeColors = { ...HARD_DEFAULTS, ...colors }
    const emailFields = {
      emailTopBarColor: emailTopBarColor || null,
      emailBottomBarColor: emailBottomBarColor || null,
      emailFooterLeftText: emailFooterLeftText.trim() || null,
      emailHeaderLogoVariant,
    }
    try {
      if (editingId) {
        setSaving(editingId)
        const res = await api.patch<AppTheme>(`/api/admin/themes/${editingId}`, { name: name.trim(), colors: safeColors, logoLight, logoDark, ...emailFields })
        if (res.error) { setFormError(res.error); return }
        setEditingId(null)
        await reload()
        return
      }
      setSaving('create')
      const res = await api.post<AppTheme>('/api/admin/themes', { name: name.trim(), colors: safeColors, logoLight, logoDark, ...emailFields })
      if (res.error) { setFormError(res.error); return }
      if (res.data) {
        setCreating(false)
        await reload()
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(null)
    }
  }

  async function setAsDefault(theme: AppTheme) {
    setSaving(theme.id)
    await api.patch(`/api/admin/themes/${theme.id}`, { isActive: true })
    setSaving(null)
    applyThemeColors({ ...HARD_DEFAULTS, ...theme.colors } as ActiveThemeColors)
    setBrandLogos({ logoLight: theme.logoLight ?? null, logoDark: theme.logoDark ?? null })
    await reload()
  }

  function applyLive(theme: AppTheme) {
    applyThemeColors({ ...HARD_DEFAULTS, ...theme.colors } as ActiveThemeColors)
    setBrandLogos({ logoLight: theme.logoLight ?? null, logoDark: theme.logoDark ?? null })
  }

  async function remove(theme: AppTheme) {
    if (!window.confirm(t('admin.themes.delete_confirm', { name: theme.name }))) return
    setSaving(theme.id)
    const res = await api.delete(`/api/admin/themes/${theme.id}`)
    setSaving(null)
    if (res.error) { setFormError(t(res.error)); return }
    await reload()
  }

  // v1.87.0: duplicate a theme (server appends "(copy)" to the name and
  // creates it inactive). Reloads so the new row shows up beneath the
  // source without a page refresh.
  async function cloneTheme(theme: AppTheme) {
    setSaving(theme.id)
    await api.post(`/api/admin/themes/${theme.id}/clone`, {})
    setSaving(null)
    await reload()
  }

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>

  return (
    <div className="flex flex-col gap-6">
      {formError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {t(formError, formError)}
        </p>
      )}

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('admin.themes.title')}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('admin.themes.section_hint', 'Controls site + email branding app-wide. Exactly one theme is Active at a time and applies everywhere a team hasn\'t picked its own (Admin → Team Management).')}
          </p>
        </div>
        {!creating && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            {t('admin.themes.new_theme')}
          </Button>
        )}
      </div>

      <LoginLogoField />

      {(creating || editingId) && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              {editingId ? t('admin.themes.edit_theme') : t('admin.themes.new_theme')}
            </p>
            <button onClick={cancelForm} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mb-3 flex flex-col gap-1">
            <Label>{t('admin.themes.name_label', 'Theme name')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <PresetRow onApply={(c) => setColors((prev) => ({ ...prev, ...c } as ThemeColors))} />
          <ColorGrid
            colors={colors}
            onFieldChange={onColorsFieldChange}
          />

          {/* Logo uploads */}
          <div className="mt-4 grid grid-cols-1 gap-4 border-t border-gray-200 pt-4 dark:border-gray-700 sm:grid-cols-2">
            <LogoUpload
              label={t('admin.themes.logo_light')}
              value={logoLight}
              onChange={setLogoLight}
            />
            <LogoUpload
              label={t('admin.themes.logo_dark')}
              value={logoDark}
              onChange={setLogoDark}
            />
          </div>
          <p className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">{t('admin.themes.logo_hint')}</p>

          <EmailTemplatePanel
            topBarColor={emailTopBarColor}
            bottomBarColor={emailBottomBarColor}
            footerLeftText={emailFooterLeftText}
            headerLogoVariant={emailHeaderLogoVariant}
            logoLight={logoLight}
            logoDark={logoDark}
            onChangeTop={setEmailTopBarColor}
            onChangeBottom={setEmailBottomBarColor}
            onChangeFooter={setEmailFooterLeftText}
            onChangeLogoVariant={setEmailHeaderLogoVariant}
          />

          <div className="mt-3 flex gap-2">
            {/* v1.91.0: guard `saving === editingId` behind `editingId !== null`.
                On the New Theme form both `saving` and `editingId` start null,
                so `saving === editingId` was `null === null === true` and the
                button was disabled + spinning from the moment the form opened. */}
            <Button size="sm" onClick={submitForm} disabled={saving === 'create' || (editingId !== null && saving === editingId) || !name.trim()}>
              {(saving === 'create' || (editingId !== null && saving === editingId)) && <Spinner className="mr-1 h-3 w-3" />}
              <Save className="mr-1 h-3.5 w-3.5" />{t('common.save')}
            </Button>
            <Button variant="outline" size="sm" onClick={previewColors} title={t('admin.themes.preview', 'Preview colors in the app')}>
              <Eye className="mr-1 h-3.5 w-3.5" />
              {t('admin.themes.preview', 'Preview')}
            </Button>
            <Button variant="ghost" size="sm" onClick={cancelForm}><X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}</Button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {themes.map((theme) => (
          <div key={theme.id} className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <p className="font-medium text-gray-900 dark:text-gray-100">{theme.name}</p>
                {theme.isActive && <Badge variant="success">{t('admin.themes.active')}</Badge>}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {Object.values(theme.colors).map((val, i) => (
                  <span key={i} className="inline-block h-4 w-4 rounded-full border border-gray-300 dark:border-gray-600" style={{ backgroundColor: val }} />
                ))}
                {(theme.logoLight || theme.logoDark) && (
                  <div className="ml-2 flex items-center gap-1">
                    {theme.logoLight && <img src={theme.logoLight} alt="light logo" className="h-5 w-5 rounded object-contain border border-gray-200 dark:border-gray-700" />}
                    {theme.logoDark && <img src={theme.logoDark} alt="dark logo" className="h-5 w-5 rounded object-contain border border-gray-200 dark:border-gray-700 bg-gray-800" />}
                  </div>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => applyLive(theme)} title={t('admin.themes.apply_tooltip')}>
                <Eye className="h-4 w-4" />
                {t('admin.themes.apply')}
              </Button>
              {/* v1.95.0: show a solid "Default" indicator on the active
                  theme instead of an "Set as Default" click affordance
                  (which was confusing — the button was still clickable
                  and re-activated the already-active theme). */}
              {theme.isActive ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" title={t('admin.themes.is_default_hint', 'This is the current default theme')}>
                  <Star className="h-3.5 w-3.5 fill-current" />
                  {t('admin.themes.is_default', 'Default')}
                </span>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setAsDefault(theme)} disabled={saving === theme.id} title={t('admin.themes.set_default_tooltip')}>
                  {saving === theme.id ? <Spinner className="h-4 w-4" /> : <Star className="h-4 w-4" />}
                  {t('admin.themes.set_default')}
                </Button>
              )}
              <button
                onClick={() => openEdit(theme)}
                className="rounded p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                aria-label={t('common.edit')}
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                onClick={() => void cloneTheme(theme)}
                disabled={saving === theme.id}
                className="rounded p-1.5 text-gray-400 hover:text-gray-700 disabled:opacity-50 dark:hover:text-gray-200"
                aria-label={t('admin.themes.clone', 'Clone')}
                title={t('admin.themes.clone', 'Clone')}
              >
                <Copy className="h-4 w-4" />
              </button>
              <button
                onClick={() => remove(theme)}
                disabled={saving === theme.id}
                className="rounded p-1.5 text-gray-400 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
                aria-label={t('common.delete')}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
        {themes.length === 0 && !creating && (
          <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">{t('admin.themes.empty')}</p>
        )}
      </div>
    </div>
  )
}

// v1.106.0: admin field for the app's public base URL. Emails render
// theme logos as <img src="{baseUrl}/public/theme-logo/…"> when this
// is set (matches how CriteriaIQ + n8n templates work). Falls back to
// CID inline attachments when blank. Persisted via /api/admin/
// integrations/public-base-url so it survives redeploys and the value
// can be edited without a config change.
function PublicBaseUrlField() {
  const [url, setUrl] = useState<string>('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [ok, setOk] = useState<null | 'saved' | 'error'>(null)
  useEffect(() => {
    void api.get<{ url: string | null }>('/api/admin/integrations/public-base-url').then((res) => {
      setUrl(res.data?.url ?? '')
      setLoaded(true)
    })
  }, [])
  async function save() {
    setSaving(true); setOk(null)
    const clean = url.trim().replace(/\/+$/, '')
    const res = await api.put<{ url: string | null }>('/api/admin/integrations/public-base-url', { url: clean || null })
    setSaving(false)
    if (res.error) setOk('error')
    else { setOk('saved'); setUrl(res.data?.url ?? '') }
    window.setTimeout(() => setOk(null), 2500)
  }
  return (
    <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
      <Label className="text-xs text-gray-700 dark:text-gray-300">Public app URL (for email images)</Label>
      <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
        Externally reachable URL where this app is served (e.g. https://impactiq.internal.example.com). Outbound emails render the theme logo + ImpactIQ mark as hosted images at this URL so Outlook shows them without a "Download pictures" prompt. Leave blank to fall back to inline CID attachments.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://impactiq.internal.example.com" className="text-xs" disabled={!loaded} />
        <Button size="sm" onClick={() => void save()} disabled={saving || !loaded}>
          {saving ? <Spinner className="mr-1 h-3 w-3" /> : <Save className="mr-1 h-3.5 w-3.5" />}
          Save
        </Button>
        {ok === 'saved' && <span className="text-[11px] text-green-700 dark:text-green-300">Saved</span>}
        {ok === 'error' && <span className="text-[11px] text-red-600 dark:text-red-400">Failed</span>}
      </div>
    </div>
  )
}

// v1.371.0: admin field for the app's support contact email, shown as a
// help icon on the pre-auth Login/Setup/Forgot/Reset-Password screens and
// the in-app header. Genuinely optional — unset by default (the icon is
// hidden entirely rather than linking to a placeholder address), same
// "inert until configured" convention as Public App URL above. Persisted
// via /api/admin/integrations/support-email; read back pre-auth (no
// session required) via the public GET /api/themes/support-email.
function SupportEmailField() {
  const { t } = useTranslation()
  const [email, setEmail] = useState<string>('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [ok, setOk] = useState<null | 'saved' | 'error'>(null)
  useEffect(() => {
    void api.get<{ email: string | null }>('/api/admin/integrations/support-email').then((res) => {
      setEmail(res.data?.email ?? '')
      setLoaded(true)
    })
  }, [])
  async function save() {
    setSaving(true); setOk(null)
    const clean = email.trim()
    const res = await api.put<{ email: string | null }>('/api/admin/integrations/support-email', { email: clean || null })
    setSaving(false)
    if (res.error) setOk('error')
    else { setOk('saved'); setEmail(res.data?.email ?? '') }
    window.setTimeout(() => setOk(null), 2500)
  }
  return (
    <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
      <Label className="text-xs text-gray-700 dark:text-gray-300">{t('admin.integrations.support_email.label')}</Label>
      <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{t('admin.integrations.support_email.hint')}</p>
      <div className="mt-2 flex items-center gap-2">
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('admin.integrations.support_email.placeholder')} className="text-xs" disabled={!loaded} />
        <Button size="sm" onClick={() => void save()} disabled={saving || !loaded}>
          {saving ? <Spinner className="mr-1 h-3 w-3" /> : <Save className="mr-1 h-3.5 w-3.5" />}
          {t('common.save')}
        </Button>
        {ok === 'saved' && <span className="text-[11px] text-green-700 dark:text-green-300">{t('common.saved')}</span>}
        {ok === 'error' && <span className="text-[11px] text-red-600 dark:text-red-400">{t('admin.integrations.support_email.failed')}</span>}
      </div>
    </div>
  )
}

// App-wide login screen logo — the large graphic above the sign-in card on
// the pre-auth pages. Independent of any theme (a team's theme never applies
// before sign-in), so it saves on its own via
// /api/admin/integrations/login-logo rather than riding the theme form.
// Unset falls back to the active theme's logo. Previewed on the same dark
// gradient the login page always uses, so the admin sees real contrast.
function LoginLogoField() {
  const { t } = useTranslation()
  const [value, setValue] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<null | 'saved' | 'error'>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  // Display size on the login screen, in px. Blank = default by the
  // image's shape (see src/shared/loginLogoSize.ts); the placeholders show
  // what that default currently resolves to for the uploaded image.
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Preview the same border-trimmed image the login screen renders, so the
  // shape-based default size and the preview both match what users see.
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!value) { setPreviewSrc(null); return }
    void trimImageDataUrl(value).then((src) => { if (!cancelled) setPreviewSrc(src) })
    return () => { cancelled = true }
  }, [value])

  type LoginLogoConfig = { dataUrl: string | null; width: number | null; height: number | null }
  function applyConfig(cfg: LoginLogoConfig | null) {
    setValue(cfg?.dataUrl ?? null)
    setWidth(cfg?.width != null ? String(cfg.width) : '')
    setHeight(cfg?.height != null ? String(cfg.height) : '')
  }

  useEffect(() => {
    void api.get<LoginLogoConfig>('/api/admin/integrations/login-logo').then((res) => {
      applyConfig(res.data ?? null)
      setLoaded(true)
    })
  }, [])

  async function persist(body: Partial<LoginLogoConfig>) {
    setSaving(true); setStatus(null); setErrorKey(null)
    const res = await api.put<LoginLogoConfig>('/api/admin/integrations/login-logo', body)
    setSaving(false)
    if (res.error) { setStatus('error'); setErrorKey(res.error) }
    else { setStatus('saved'); applyConfig(res.data ?? null) }
    window.setTimeout(() => setStatus(null), 2500)
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > LOGO_MAX_BYTES) { setStatus('error'); setErrorKey('admin.themes.login_logo.too_large'); return }
    setNatural(null)
    await persist({ dataUrl: await fileToDataUrl(file) })
  }

  function parseDim(raw: string): number | null | 'invalid' {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n < LOGIN_LOGO_SIZE_MIN || n > LOGIN_LOGO_SIZE_MAX) return 'invalid'
    return n
  }

  async function saveSize() {
    const w = parseDim(width)
    const h = parseDim(height)
    if (w === 'invalid' || h === 'invalid') { setStatus('error'); setErrorKey('admin.themes.login_logo.size_invalid'); return }
    await persist({ width: w, height: h })
  }

  const fallback = defaultLoginLogoSize(natural?.width ?? 0, natural?.height ?? 0)

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">{t('admin.themes.login_logo.title')}</p>
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{t('admin.themes.login_logo.hint')}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div
          className="flex h-20 w-48 items-center justify-center rounded-md border border-gray-200 dark:border-gray-700"
          style={{ background: 'linear-gradient(to right, #050b39 0%, #001cab 100%)' }}
        >
          {value
            ? previewSrc && <img src={previewSrc} alt="" className="max-h-16 max-w-[11rem] object-contain" onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} />
            : <span className="px-2 text-center text-[11px] text-white/70">{t('admin.themes.login_logo.using_theme')}</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => inputRef.current?.click()} disabled={!loaded || saving}>
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Upload className="h-3.5 w-3.5" />}
            {value ? t('admin.themes.login_logo.replace') : t('admin.themes.login_logo.upload')}
          </Button>
          {value && (
            <Button type="button" size="sm" variant="outline" onClick={() => void persist({ dataUrl: null })} disabled={saving}>
              <Trash2 className="h-3.5 w-3.5" />
              {t('admin.themes.login_logo.remove')}
            </Button>
          )}
          <input ref={inputRef} type="file" accept="image/svg+xml,image/png,image/jpeg" className="hidden" onChange={(e) => void handleFile(e)} />
        </div>
        <span className="text-[10px] text-gray-400 dark:text-gray-500">{t('admin.themes.login_logo.formats')}</span>
        {status === 'saved' && <span className="flex items-center gap-1 text-[11px] text-green-700 dark:text-green-300"><Check className="h-3 w-3" />{t('common.saved')}</span>}
        {status === 'error' && <span className="text-[11px] text-red-600 dark:text-red-400">{t(errorKey ?? 'admin.themes.login_logo.failed', t('admin.themes.login_logo.failed'))}</span>}
      </div>
      {value && (
        <div className="mt-4 border-t border-gray-100 pt-3 dark:border-gray-800">
          <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">{t('admin.themes.login_logo.size_title')}</p>
          <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{t('admin.themes.login_logo.size_hint')}</p>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="login-logo-width" className="text-[11px]">{t('admin.themes.login_logo.width')}</Label>
              <Input id="login-logo-width" type="number" inputMode="numeric" min={LOGIN_LOGO_SIZE_MIN} max={LOGIN_LOGO_SIZE_MAX} value={width} onChange={(e) => setWidth(e.target.value)} placeholder={String(fallback.width)} className="h-8 w-28 text-xs" disabled={saving} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="login-logo-height" className="text-[11px]">{t('admin.themes.login_logo.height')}</Label>
              <Input id="login-logo-height" type="number" inputMode="numeric" min={LOGIN_LOGO_SIZE_MIN} max={LOGIN_LOGO_SIZE_MAX} value={height} onChange={(e) => setHeight(e.target.value)} placeholder={String(fallback.height)} className="h-8 w-28 text-xs" disabled={saving} />
            </div>
            <Button type="button" size="sm" onClick={() => void saveSize()} disabled={saving}>
              <Save className="h-3.5 w-3.5" />
              {t('admin.themes.login_logo.save_size')}
            </Button>
            {(width || height) && (
              <Button type="button" size="sm" variant="outline" onClick={() => void persist({ width: null, height: null })} disabled={saving}>
                <RotateCcw className="h-3.5 w-3.5" />
                {t('admin.themes.login_logo.reset_size')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
