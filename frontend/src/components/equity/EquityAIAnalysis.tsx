// frontend/src/components/equity/EquityAIAnalysis.tsx
import { useMarketStore } from '../../store/marketStore'

interface Props { onRegisterTrade: () => void }

// --- Color helpers ---

const tradeSignalStyle = {
  trade: { bg: 'bg-emerald-500/15 border-emerald-500/40', text: 'text-emerald-400', label: 'OPERAR' },
  wait:  { bg: 'bg-yellow-500/15 border-yellow-500/40',  text: 'text-yellow-400',  label: 'AGUARDAR' },
  avoid: { bg: 'bg-red-500/15 border-red-500/40',        text: 'text-red-400',     label: 'EVITAR' },
}

const regimeScoreColor = (score: number) => {
  if (score >= 7) return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40'
  if (score >= 4) return 'bg-yellow-500/15 text-yellow-400 border-yellow-500/40'
  return 'bg-red-500/15 text-red-400 border-red-500/40'
}

const confidenceStyle = {
  ALTA:  'bg-emerald-500/15 text-emerald-400 border-emerald-500/40',
  MÉDIA: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/40',
  BAIXA: 'bg-red-500/15 text-red-400 border-red-500/40',
}

const rsiZoneStyle = {
  oversold:   'bg-blue-500/15 text-blue-400 border-blue-500/40',
  neutral:    'bg-slate-700/50 text-slate-400 border-slate-600/40',
  overbought: 'bg-red-500/15 text-red-400 border-red-500/40',
}

const trendStyle = {
  uptrend:   'bg-emerald-500/15 text-emerald-400 border-emerald-500/40',
  downtrend: 'bg-red-500/15 text-red-400 border-red-500/40',
  sideways:  'bg-slate-700/50 text-slate-400 border-slate-600/40',
}

const rsiZoneLabel = { oversold: 'RSI: Sobrevendido', neutral: 'RSI: Neutro', overbought: 'RSI: Sobrecomprado' }
const trendLabel   = { uptrend: 'Alta', downtrend: 'Baixa', sideways: 'Lateral' }

// Generic pill badge
function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wide ${className}`}>
      {children}
    </span>
  )
}

export function EquityAIAnalysis({ onRegisterTrade }: Props) {
  const equityAnalysis     = useMarketStore((s) => s.equityAnalysis)
  const equityAnalysisLoading = useMarketStore((s) => s.equityAnalysisLoading)
  const setEquityAnalysis  = useMarketStore((s) => s.setEquityAnalysis)

  if (equityAnalysisLoading) {
    return (
      <div id="equity-ai-analysis" className="card border-[#2a1f5e] text-sm text-text-secondary animate-pulse">
        🤖 Analisando...
      </div>
    )
  }

  if (!equityAnalysis) return null

  const signal = tradeSignalStyle[equityAnalysis.trade_signal]
  const showNoTradeReasons =
    equityAnalysis.trade_signal !== 'trade' &&
    equityAnalysis.no_trade_reasons.length > 0

  return (
    <div id="equity-ai-analysis" className="card border-[#2a1f5e] space-y-3">

      {/* ── Header row ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-purple-400 uppercase tracking-wide font-semibold">🤖 IA</span>
        <span className="font-bold text-text-primary text-sm">{equityAnalysis.symbol}</span>

        {/* trade_signal */}
        <Badge className={`${signal.bg} ${signal.text}`}>{signal.label}</Badge>

        {/* equity_regime_score */}
        <Badge className={regimeScoreColor(equityAnalysis.equity_regime_score)}>
          Regime {equityAnalysis.equity_regime_score}/10
        </Badge>

        {/* confidence */}
        <Badge className={confidenceStyle[equityAnalysis.confidence]}>
          Conf {equityAnalysis.confidence}
        </Badge>

        <div className="flex-1" />
        <button
          onClick={() => setEquityAnalysis(null)}
          className="text-gray-600 hover:text-text-secondary text-sm leading-none"
          aria-label="Fechar"
        >
          ✕
        </button>
      </div>

      {/* ── Metadata badges row ── */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge className={rsiZoneStyle[equityAnalysis.rsi_zone]}>
          {rsiZoneLabel[equityAnalysis.rsi_zone]}
        </Badge>
        <Badge className={trendStyle[equityAnalysis.trend]}>
          {trendLabel[equityAnalysis.trend]}
        </Badge>
        <Badge className="bg-slate-700/50 text-slate-300 border-slate-600/40">
          {equityAnalysis.timeframe}
        </Badge>
        <Badge
          className={
            equityAnalysis.catalyst_confirmed
              ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40'
              : 'bg-slate-700/50 text-slate-400 border-slate-600/40'
          }
        >
          {equityAnalysis.catalyst_confirmed ? '✓ Catalisador' : '✗ Catalisador'}
        </Badge>
      </div>

      {/* ── Setup narrative ── */}
      <p className="text-sm text-text-secondary leading-relaxed">{equityAnalysis.setup}</p>

      {/* ── Trade levels grid ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {([
          { label: 'Entrada',  value: equityAnalysis.entry_range,  color: 'text-text-primary' },
          { label: 'Alvo',     value: equityAnalysis.target,        color: 'text-emerald-400' },
          { label: 'Stop',     value: equityAnalysis.stop,          color: 'text-red-400' },
          { label: 'R/R',      value: equityAnalysis.risk_reward,   color: 'text-yellow-400' },
        ] as const).map(({ label, value, color }) => (
          <div key={label} className="bg-bg-elevated rounded-lg p-2 text-center">
            <div className="text-[10px] text-text-muted uppercase tracking-wide mb-0.5">{label}</div>
            <div className={`text-sm font-bold ${color}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* ── Key levels ── */}
      {(equityAnalysis.key_levels.support.length > 0 || equityAnalysis.key_levels.resistance.length > 0) && (
        <div className="space-y-1.5">
          {equityAnalysis.key_levels.support.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] text-text-muted uppercase tracking-wide w-16 shrink-0">Suporte</span>
              {equityAnalysis.key_levels.support.map((lvl) => (
                <span
                  key={lvl}
                  className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] font-mono"
                >
                  ${lvl.toFixed(2)}
                </span>
              ))}
            </div>
          )}
          {equityAnalysis.key_levels.resistance.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] text-text-muted uppercase tracking-wide w-16 shrink-0">Resist.</span>
              {equityAnalysis.key_levels.resistance.map((lvl) => (
                <span
                  key={lvl}
                  className="inline-flex items-center px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 text-[11px] font-mono"
                >
                  ${lvl.toFixed(2)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Invalidation level ── */}
      {equityAnalysis.invalidation_level !== null && (
        <div className="text-xs text-red-400 bg-red-500/5 border border-red-500/20 rounded px-3 py-1.5">
          ⛔ Invalidação: ${equityAnalysis.invalidation_level.toFixed(2)}
        </div>
      )}

      {/* ── No-trade reasons (only when signal != trade) ── */}
      {showNoTradeReasons && (
        <div className="bg-red-500/5 border border-red-500/20 rounded px-3 py-2 space-y-1">
          <div className="text-[10px] text-red-400 font-semibold uppercase tracking-wide mb-1">
            Razões para não operar
          </div>
          {equityAnalysis.no_trade_reasons.map((reason, i) => (
            <div key={i} className="text-xs text-red-300 flex gap-1.5">
              <span className="text-red-500 shrink-0">•</span>
              {reason}
            </div>
          ))}
        </div>
      )}

      {/* ── Warning ── */}
      {equityAnalysis.warning && (
        <div className="text-xs text-yellow-500 bg-yellow-500/5 border border-yellow-500/20 rounded px-3 py-2">
          ⚠ {equityAnalysis.warning}
        </div>
      )}

      {/* ── Action buttons ── */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={onRegisterTrade}
          className="px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-200 bg-[#00ff88]/10 border border-[#00ff88]/30 text-[#00ff88] hover:bg-[#00ff88]/20 hover:border-[#00ff88]/50 active:scale-95"
        >
          ✓ Registrar compra
        </button>
        <button
          onClick={() => setEquityAnalysis(null)}
          className="px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-200 bg-bg-elevated border border-border-subtle text-text-secondary hover:bg-border-subtle hover:text-text-primary"
        >
          Descartar
        </button>
      </div>
    </div>
  )
}
