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
      className="rounded-lg border border-border-subtle bg-bg-card px-4 py-3 mb-4 flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:justify-between"
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline gap-2 text-[10px] uppercase tracking-wide text-text-muted">
          <span>Último sinal (10:30 / 15:00 ET)</span>
          <span className="text-[10px] text-text-muted normal-case">
            {formatTimestamp(signal.timestamp)}
          </span>
        </div>
        <div className="flex items-baseline gap-3 flex-wrap">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-base sm:text-lg font-semibold ${signalColor} bg-white/5`}
          >
            {label}
          </span>
          <span className="text-xs text-text-secondary">
            regime <span className="font-num text-text-primary">{signal.regime_score}</span>/10
          </span>
        </div>
      </div>
      {hasReasons && (
        <div className="mt-1 sm:mt-0 sm:text-right max-w-xs text-[11px] text-text-muted">
          <span
            className="inline-block cursor-help"
            title={signal.no_trade_reasons?.join(' · ') ?? ''}
          >
            — {signal.no_trade_reasons?.[0]}
            {signal.no_trade_reasons && signal.no_trade_reasons.length > 1 && ' · ver detalhes'}
          </span>
        </div>
      )}
    </div>
  )
}
