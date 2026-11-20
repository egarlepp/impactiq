import { useMemo, useState, useEffect } from 'react'

export type SortDir = 'asc' | 'desc' | null

// Shared client-side helper for admin data tables: per-column search + sort +
// pagination. Kept intentionally small so both LoginHistory and AuditLog can
// reuse it without dragging in a full table library.
export function useTableView<T>(
  rows: T[],
  getters: Record<string, (row: T) => string>,
  opts: { pageSize?: number; resetKey?: unknown } = {},
) {
  const pageSize = opts.pageSize ?? 15
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>(null)
  const [page, setPage] = useState(1)

  // Reset page to 1 whenever filters, sort, or external reset key change.
  const filtersSig = Object.entries(filters).map(([k, v]) => `${k}=${v}`).join('|')
  useEffect(() => { setPage(1) }, [filtersSig, sortKey, sortDir, opts.resetKey])

  function setFilter(col: string, val: string) {
    setFilters((f) => ({ ...f, [col]: val }))
  }

  function toggleSort(col: string) {
    if (sortKey !== col) { setSortKey(col); setSortDir('asc'); return }
    if (sortDir === 'asc') { setSortDir('desc'); return }
    if (sortDir === 'desc') { setSortKey(null); setSortDir(null); return }
    setSortDir('asc')
  }

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      for (const [col, val] of Object.entries(filters)) {
        if (!val) continue
        const getter = getters[col]
        if (!getter) continue
        const cell = getter(r).toLowerCase()
        if (!cell.includes(val.toLowerCase())) return false
      }
      return true
    })
  }, [rows, filters, getters])

  const sorted = useMemo(() => {
    if (!sortKey || !sortDir) return filtered
    const getter = getters[sortKey]
    if (!getter) return filtered
    const copy = filtered.slice()
    copy.sort((a, b) => {
      const av = getter(a)
      const bv = getter(b)
      const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' })
      return sortDir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [filtered, sortKey, sortDir, getters])

  const total = sorted.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * pageSize
  const visible = sorted.slice(start, start + pageSize)

  return {
    visible,
    total,
    page: safePage,
    setPage,
    totalPages,
    pageSize,
    filters,
    setFilter,
    sortKey,
    sortDir,
    toggleSort,
  }
}
