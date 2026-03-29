// frontend/src/components/options/CandidateList.tsx

import type { OptionCandidateFE } from '../../store/marketStore'

interface Props {
  candidates: OptionCandidateFE[]
  selectedSymbol: string | null
  onSelect: (symbol: string) => void
  marketOpen?: boolean | null
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-[#00ff88]'
  if (score >= 60) return 'text-[#ffcc00]'
  return 'text-text-secondary'
}

export function CandidateList({ candidates, selectedSymbol, onSelect, marketOpen }: Props) {
  if (candidates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-1.5 px-4 text-center">
        <p className="text-text-secondary text-sm">Nenhum candidato encontrado</p>
        {marketOpen === false && (
          <p className="text-[10px] text-text-muted">
            Mercado fechado — candidatos baseados em IVR e OI de fechamento
          </p>
        )}
        {marketOpen === true && (
          <p className="text-[10px] text-text-muted">
            Nenhum ativo passou nos filtros de liquidez para este preset
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5 p-2">
      <p className="text-[10px] text-text-muted uppercase tracking-widest mb-1">Top Candidatos</p>
      {candidates.map((c) => {
        const isSelected = c.symbol === selectedSymbol
        return (
          <button
            key={c.symbol}
            onClick={() => onSelect(c.symbol)}
            className={`w-full text-left rounded-md px-3 py-2 border transition-colors ${
              isSelected
                ? 'bg-[#00ff88]/10 border-[#00ff88]/30'
                : 'bg-bg-elevated border-border-subtle hover:bg-white/[0.04] hover:border-border'
            }`}
          >
            <div className="flex justify-between items-center">
              <span className={`font-bold text-sm ${isSelected ? 'text-[#00ff88]' : 'text-text-primary'}`}>
                {c.symbol}
              </span>
              <span className={`text-xs font-medium ${scoreColor(c.liquidityScore)}`}>
                Score {c.liquidityScore}
              </span>
            </div>
            <div className="text-[10px] text-text-muted mt-0.5 flex items-center gap-1">
              <span>IVR {c.ivRank.toFixed(0)}</span>
              <span className={`text-[9px] px-1 rounded ${c.ivRankSource === 'tastytrade' ? 'text-[#00ff88]/70' : 'text-[#ffcc00]/70'}`}>
                {c.ivRankSource === 'tastytrade' ? '[TT]' : '[est.]'}
              </span>
              <span>· Spread ${c.bidAskSpread.toFixed(2)} · OI {(c.openInterest / 1000).toFixed(0)}k</span>
            </div>
          </button>
        )
      })}
    </div>
  )
}
