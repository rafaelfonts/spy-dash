// frontend/src/components/equity/EquityAIAnalysis.tsx
import { useMarketStore } from '../../store/marketStore'

interface Props { onRegisterTrade: () => void }

const confidenceColor = {
  ALTA: 'text-[#00ff88]',
  MÉDIA: 'text-yellow-500',
  BAIXA: 'text-red-400',
}

export function EquityAIAnalysis({ onRegisterTrade }: Props) {
  const { equityAnalysis, equityAnalysisLoading, setEquityAnalysis } = useMarketStore()

  if (equityAnalysisLoading) {
    return (
      <div id="equity-ai-analysis" className="card border-[#2a1f5e] text-sm text-text-secondary animate-pulse">
        🤖 Analisando...
      </div>
    )
  }

  if (!equityAnalysis) return null

  return (
    <div id="equity-ai-analysis" className="card border-[#2a1f5e]">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs text-purple-400 uppercase tracking-wide">🤖 Análise IA</span>
        <span className="font-bold text-text-primary">{equityAnalysis.symbol}</span>
        <span className={`text-xs font-bold ml-1 ${confidenceColor[equityAnalysis.confidence]}`}>
          {equityAnalysis.confidence}
        </span>
        <div className="flex-1" />
        <button onClick={() => setEquityAnalysis(null)} className="text-gray-600 hover:text-text-secondary text-sm">✕</button>
      </div>

      <p className="text-sm text-text-secondary leading-relaxed mb-3">{equityAnalysis.setup}</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        {[
          { label: 'Entrada', value: equityAnalysis.entry_range, color: 'text-text-primary' },
          { label: 'Alvo', value: equityAnalysis.target, color: 'text-[#00ff88]' },
          { label: 'Stop', value: equityAnalysis.stop, color: 'text-red-400' },
          { label: 'R/R', value: equityAnalysis.risk_reward, color: 'text-yellow-400' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-bg-elevated rounded-lg p-2 text-center">
            <div className="text-[10px] text-text-muted uppercase">{label}</div>
            <div className={`text-sm font-bold ${color}`}>{value}</div>
          </div>
        ))}
      </div>

      {equityAnalysis.warning && (
        <div className="text-xs text-yellow-500 bg-yellow-500/5 border border-yellow-500/20 rounded px-3 py-2 mb-3">
          ⚠ {equityAnalysis.warning}
        </div>
      )}

      <div className="flex gap-2">
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
