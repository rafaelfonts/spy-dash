import { useMarketStore } from '../../store/marketStore'

export function MarketToggle() {
  const market = useMarketStore((s) => s.market)
  const setMarket = useMarketStore((s) => s.setMarket)

  return (
    <div className="flex items-center gap-1 rounded-md border border-border-subtle bg-card p-0.5">
      <button
        onClick={() => setMarket('US')}
        className="px-2.5 py-1 rounded text-[11px] font-semibold tracking-wider transition-all"
        style={{
          backgroundColor: market === 'US' ? 'rgba(0,255,136,0.12)' : 'transparent',
          color: market === 'US' ? '#00ff88' : 'var(--color-text-muted)',
          borderColor: market === 'US' ? 'rgba(0,255,136,0.25)' : 'transparent',
          border: market === 'US' ? '1px solid' : '1px solid transparent',
        }}
        aria-pressed={market === 'US'}
      >
        US SPY
      </button>
      <button
        onClick={() => setMarket('BR')}
        className="px-2.5 py-1 rounded text-[11px] font-semibold tracking-wider transition-all"
        style={{
          backgroundColor: market === 'BR' ? 'rgba(0,255,136,0.12)' : 'transparent',
          color: market === 'BR' ? '#00ff88' : 'var(--color-text-muted)',
          borderColor: market === 'BR' ? 'rgba(0,255,136,0.25)' : 'transparent',
          border: market === 'BR' ? '1px solid' : '1px solid transparent',
        }}
        aria-pressed={market === 'BR'}
      >
        BR BOVA11
      </button>
    </div>
  )
}
