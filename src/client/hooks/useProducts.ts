import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

export interface Product { id: string; name: string; space: string | null; abbreviation: string | null; isActive: boolean; iconDataUrl?: string | null }

export function useTeamProducts(teamId: string | null) {
  const [products, setProducts] = useState<Product[]>([])
  useEffect(() => {
    if (!teamId) { setProducts([]); return }
    api.get<Product[]>(`/api/teams/${teamId}/products`).then((res) => setProducts(res.data ?? []))
  }, [teamId])
  return products
}
