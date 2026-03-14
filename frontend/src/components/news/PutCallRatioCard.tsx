import { useMarketStore } from '../../store/marketStore'
import type { PutCallRatioEntry } from '../../store/marketStore'

function sentimentColor(label: PutCallRatioEntry['sentimentLabel']): string {
  if (label === 'bullish') return '#00ff88'
  if (label === 'bearish') return '#ff4f4f'
  return '#ffcc00'
}

function sentimentText(label: PutCallRatioEntry['sentimentLabel']): string {
  if (label === 'bullish') return 'Altista'
  if (label === 'bearish') return 'Baixista'
  return 'Neutro'
}

function putPct(entry: PutCallRatioEntry): number {
  const total = entry.putVolume + entry.callVolume
  return total === 0 ? 50 : Math.round((entry.putVolume / total) * 100)
}

export function PutCallRatioCard() {
  const pcr = useMarketStore((s) => s.putCallRatio)

  const primary =
    pcr?.entries.length
      ? pcr.entries.reduce((best, e) =>
          e.putVolume + e.callVolume > best.putVolume + best.callVolume ? e : best,
        )
      : null

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-text-muted uppercase tracking-[1.5px] font-display font-bold">
          Put/Call Ratio
        </span>
        {primary && (
          <span
            className="text-[8px] font-bold px-[6px] py-[2px] rounded font-display"
            style={{
              background: sentimentColor(primary.sentimentLabel) + '22',
              color: sentimentColor(primary.sentimentLabel),
              border: `1px solid ${sentimentColor(primary.sentimentLabel)}44`,
            }}
          >
            {sentimentText(primary.sentimentLabel)}
          </span>
        )}
        <div className="flex-1 h-px bg-border-subtle" />
      </div>

      {/* Main ratio */}
      <div className="flex items-baseline gap-2">
        <span
          className="text-[28px] font-bold font-mono"
          style={{ color: primary ? sentimentColor(primary.sentimentLabel) : '#666' }}
        >
          {primary ? primary.ratio.toFixed(2) : '—'}
        </span>
        {primary && (
          <span className="text-[11px] font-bold text-text-secondary font-display">
            {sentimentText(primary.sentimentLabel)}
          </span>
        )}
      </div>

      {/* Per-expiration rows */}
      {pcr?.entries.length ? (
        <div className="flex flex-col gap-[5px]">
          {pcr.entries.map((entry) => {
            const pp = putPct(entry)
            return (
              <div
                key={entry.tier}
                className="flex items-center gap-2 bg-[#0d0d0d] border border-[#1a1a1a] rounded px-[10px] py-[7px]"
              >
                <span className="text-[9px] text-text-muted uppercase tracking-[0.5px] font-display font-bold w-[54px] flex-shrink-0">
                  {entry.tier}
                </span>
                <div className="flex-1 h-[5px] bg-[#1a1a1a] rounded-full overflow-hidden relative">
                  <div
                    className="absolute left-0 top-0 h-full bg-[#ff4f4f] rounded-l-full"
                    style={{ width: `${pp}%` }}
                  />
                  <div
                    className="absolute right-0 top-0 h-full bg-[#00ff88] rounded-r-full"
                    style={{ width: `${100 - pp}%` }}
                  />
                </div>
                <span
                  className="text-[10px] font-bold font-mono w-[34px] text-right flex-shrink-0"
                  style={{ color: sentimentColor(entry.sentimentLabel) }}
                >
                  {entry.ratio.toFixed(2)}
                </span>
                <span
                  className="text-[8px] font-bold font-display w-[46px] text-right flex-shrink-0"
                  style={{ color: sentimentColor(entry.sentimentLabel) }}
                >
                  {sentimentText(entry.sentimentLabel)}
                </span>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="text-[10px] text-text-muted font-display">—</div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-3 text-[9px] text-text-muted font-display">
        <div className="flex items-center gap-1">
          <div className="w-[6px] h-[6px] rounded-full bg-[#ff4f4f]" />
          <span>Puts</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-[6px] h-[6px] rounded-full bg-[#00ff88]" />
          <span>Calls</span>
        </div>
        <span className="ml-auto text-[8px]">Tradier · 15min delay</span>
      </div>
    </div>
  )
}
