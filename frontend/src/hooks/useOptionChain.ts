import { useEffect, useRef } from 'react'
import { useMarketStore } from '../store/marketStore'
import type { OptionExpiry, OptionChainMeta } from '../store/marketStore'
import { supabase } from '../lib/supabase'

const REFRESH_INTERVAL = 5 * 60_000 // 5 min — matches backend cache TTL

export function useOptionChain(): void {
  const setOptionChain = useMarketStore((s) => s.setOptionChain)
  const setOptionChainMeta = useMarketStore((s) => s.setOptionChainMeta)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    async function fetchChain() {
      if (!mountedRef.current) return
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        const authHeader = session?.access_token
          ? `Bearer ${session.access_token}`
          : ''

        const res = await fetch('/api/option-chain', {
          headers: authHeader ? { Authorization: authHeader } : {},
        })
        if (!res.ok || !mountedRef.current) return

        const json = (await res.json()) as { data: OptionExpiry[]; meta?: OptionChainMeta }
        if (mountedRef.current && Array.isArray(json.data)) {
          setOptionChain(json.data)
          if (json.meta) setOptionChainMeta(json.meta)
        }
      } catch {
        // Non-fatal — panel stays hidden until a successful fetch
      }
    }

    fetchChain()
    const timer = setInterval(fetchChain, REFRESH_INTERVAL)

    return () => {
      mountedRef.current = false
      clearInterval(timer)
    }
  }, [setOptionChain, setOptionChainMeta])
}
