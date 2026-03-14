import { useMarketStore } from '../../store/marketStore'
import { fmtPrice, fmtPct } from '../../lib/formatters'

function fmtOrDash(val: number | null | undefined, fmt: (v: number) => string): string {
  return val != null ? fmt(val) : '—'
}

function regimeLabel(score: number | null | undefined): string {
  if (score == null) return '—'
  if (score >= 7) return 'Positivo'
  if (score <= 3) return 'Negativo'
  return 'Moderado'
}

export function TickerStrip() {
  const spy = useMarketStore((s) => s.spy)
  const vix = useMarketStore((s) => s.vix)
  const ivRank = useMarketStore((s) => s.ivRank)
  const regime = useMarketStore((s) => s.regimePreview)  // NOTE: field is `regimePreview`, NOT `regime`
  const pcr = useMarketStore((s) => s.putCallRatio)
  const fearGreed = useMarketStore((s) => s.newsFeed?.fearGreed)

  // Primary PCR entry: highest total volume, fallback to first
  const primaryPcr =
    pcr?.entries.length
      ? pcr.entries.reduce((best, e) =>
          e.putVolume + e.callVolume > best.putVolume + best.callVolume ? e : best,
        )
      : null

  const items = [
    {
      label: 'SPY',
      value: fmtOrDash(spy.last, fmtPrice),
      change: spy.changePct != null ? fmtPct(spy.changePct) : null,
      changePositive: (spy.changePct ?? 0) >= 0,
    },
    {
      label: 'IV Rank',
      value: fmtOrDash(ivRank?.value, (v) => v.toFixed(1)),
      change: ivRank?.ivx != null ? `IVx ${ivRank.ivx.toFixed(1)}%` : null,
      changePositive: null,
    },
    {
      label: 'VIX',
      value: fmtOrDash(vix.last, (v) => v.toFixed(2)),
      change: vix.changePct != null ? fmtPct(vix.changePct) : null,
      changePositive: (vix.changePct ?? 0) <= 0,
    },
    {
      label: 'Regime',
      value: regime?.score != null ? String(regime.score) + '/10' : '—',
      change: regime?.score != null ? regimeLabel(regime.score) : null,
      changePositive: null,
    },
    {
      label: 'P/C',
      value: primaryPcr != null ? primaryPcr.ratio.toFixed(2) : '—',
      change:
        primaryPcr != null
          ? primaryPcr.sentimentLabel === 'bullish'
            ? 'Altista'
            : primaryPcr.sentimentLabel === 'bearish'
              ? 'Baixista'
              : 'Neutro'
          : null,
      changePositive:
        primaryPcr?.sentimentLabel === 'bullish'
          ? true
          : primaryPcr?.sentimentLabel === 'bearish'
            ? false
            : null,
    },
    {
      label: 'F&G',
      value: fearGreed?.score != null ? String(fearGreed.score) : '—',
      change: fearGreed?.label ?? null,
      changePositive: fearGreed?.score != null ? fearGreed.score >= 45 : null,
    },
  ]

  return (
    <div className="bg-[#0d0d0d] border-b border-border-subtle h-[34px] overflow-x-auto">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-center h-full gap-0">
        {items.map((item, i) => (
          <div key={item.label} className="flex items-center">
            {i > 0 && (
              <div className="w-px h-[14px] bg-[#222] mx-0 flex-shrink-0" />
            )}
            <div className="flex items-center gap-[5px] px-3 whitespace-nowrap">
              <span className="text-[9px] text-text-muted uppercase tracking-[0.8px] font-display font-semibold">
                {item.label}
              </span>
              <span className="text-[12px] font-bold font-mono text-text-primary">
                {item.value}
              </span>
              {item.change && (
                <span
                  className={`text-[9px] font-mono ${
                    item.changePositive === true
                      ? 'text-[#00ff88]'
                      : item.changePositive === false
                        ? 'text-[#ff4f4f]'
                        : 'text-text-muted'
                  }`}
                >
                  {item.change}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
