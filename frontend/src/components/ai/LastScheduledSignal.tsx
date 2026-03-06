import { useMarketStore } from '../../store/marketStore'
import type { TradeSignalPayload } from '../../store/marketStore'

const SIGNAL_LABELS: Record<TradeSignalPayload['trade_signal'], string> = {
  trade: 'Operar',
  wait: 'Aguardar',
  avoid: 'Não operar',
}

function formatTimestamp(ts: number): string {
  try {
    const d = new Date(ts)
    const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    return et.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + ' ET'
  } catch {
    return ''
  }
}

export function LastScheduledSignal() {
  const signal = useMarketStore((s) => s.lastScheduledSignal)
  if (!signal) return null

  const label = SIGNAL_LABELS[signal.trade_signal]
  const signalColor =
    signal.trade_signal === 'trade'
      ? 'text-[#00ff88]'
      : signal.trade_signal === 'wait'
        ? 'text-yellow-400'
        : 'text-red-400/90'

  const hasReasons = signal.no_trade_reasons?.length > 0

  return (
    <div
      className="rounded-lg border border-border-subtle bg-bg-card px-4 py-2.5 mb-4 flex flex-wrap items-center gap-x-4 gap-y-1"
      title={hasReasons ? signal.no_trade_reasons.join(' · ') : undefined}
    >
      <span className="text-[10px] uppercase tracking-wide text-text-muted">
        Último sinal (10:30 / 15:00 ET)
      </span>
      <span className={`text-sm font-semibold ${signalColor}`}>{label}</span>
      <span className="text-xs text-text-secondary">
        regime {signal.regime_score}/10
      </span>
      <span className="text-[10px] text-text-muted">
        {formatTimestamp(signal.timestamp)}
      </span>
      {hasReasons && (
        <span className="text-[10px] text-text-muted truncate max-w-[280px]" title={signal.no_trade_reasons.join(' · ')}>
          — {signal.no_trade_reasons.join(' · ')}
        </span>
      )}
    </div>
  )
}
