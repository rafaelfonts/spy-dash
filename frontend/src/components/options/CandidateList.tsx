// frontend/src/components/options/CandidateList.tsx

import type { OptionCandidateFE } from '../../store/marketStore'

interface Props {
  candidates: OptionCandidateFE[]
  selectedSymbol: string | null
  onSelect: (symbol: string) => void
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-400'
  if (score >= 60) return 'text-yellow-400'
  return 'text-gray-400'
}

export function CandidateList({ candidates, selectedSymbol, onSelect }: Props) {
  if (candidates.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
        Nenhum candidato encontrado
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5 p-2">
      <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Top Candidatos</p>
      {candidates.map((c) => {
        const isSelected = c.symbol === selectedSymbol
        return (
          <button
            key={c.symbol}
            onClick={() => onSelect(c.symbol)}
            className={`w-full text-left rounded-md px-3 py-2 border transition-colors ${
              isSelected
                ? 'bg-blue-900/30 border-blue-600/60'
                : 'bg-gray-800 border-gray-700 hover:bg-gray-750 hover:border-gray-600'
            }`}
          >
            <div className="flex justify-between items-center">
              <span className={`font-bold text-sm ${isSelected ? 'text-blue-300' : 'text-white'}`}>
                {c.symbol}
              </span>
              <span className={`text-xs font-medium ${scoreColor(c.liquidityScore)}`}>
                Score {c.liquidityScore}
              </span>
            </div>
            <div className="text-[10px] text-gray-400 mt-0.5">
              IVR {c.ivRank.toFixed(0)} · Spread ${c.bidAskSpread.toFixed(2)} · OI {(c.openInterest / 1000).toFixed(0)}k
            </div>
          </button>
        )
      })}
    </div>
  )
}
