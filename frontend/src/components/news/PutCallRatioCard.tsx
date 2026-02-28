import type { PutCallRatioData } from '../../store/marketStore'

interface Props {
  data: PutCallRatioData | null
}

function getStyle(label: string): { color: string; text: string } {
  if (label === 'bearish') return { color: '#ff4444', text: 'Bearish (hedge)' }
  if (label === 'bullish') return { color: '#00ff88', text: 'Bullish (calls)' }
  return { color: '#ffcc00', text: 'Neutro' }
}

export function PutCallRatioCard({ data }: Props) {
  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center py-3 gap-1">
        <div className="text-[11px] text-text-muted">P/C Ratio indisponível</div>
        <div className="text-[9px] text-text-muted opacity-60">Tradier — aguardando dados</div>
      </div>
    )
  }

  const { color, text } = getStyle(data.label)
  const total = data.putVolume + data.callVolume
  const putPct = total > 0 ? (data.putVolume / total) * 100 : 50

  return (
    <div className="space-y-3">
      {/* Ratio + label */}
      <div className="flex items-baseline gap-3">
        <span className="text-2xl font-num font-bold" style={{ color }}>
          {data.ratio.toFixed(2)}
        </span>
        <span className="text-xs font-semibold" style={{ color }}>{text}</span>
      </div>

      {/* Volume bar: puts (left, red) vs calls (right, green) */}
      <div>
        <div className="flex justify-between text-[10px] text-text-muted mb-1">
          <span>Puts {data.putVolume.toLocaleString('en-US')}</span>
          <span>Calls {data.callVolume.toLocaleString('en-US')}</span>
        </div>
        <div className="h-2 rounded-full overflow-hidden bg-bg-surface flex">
          <div
            className="h-full bg-red-500/60 transition-all duration-500"
            style={{ width: `${putPct}%` }}
          />
          <div className="h-full flex-1 bg-[#00ff88]/40" />
        </div>
      </div>

      <div className="text-[9px] text-text-muted">
        Expiração {data.expiration} · Tradier
      </div>
    </div>
  )
}
