// frontend/src/components/options/OptionScreenerPanel.tsx

import { useOptionScreener } from '../../hooks/useOptionScreener'
import { CandidateList } from './CandidateList'
import { DeepDivePanel } from './DeepDivePanel'
import type { ScreenerPresetFE, DeltaProfileFE } from '../../store/marketStore'

const PRESETS: { id: ScreenerPresetFE; label: string; icon: string }[] = [
  { id: 'flight_to_safety', label: 'Flight to Safety', icon: '🛡️' },
  { id: 'blue_chips',       label: 'Blue Chips',        icon: '📊' },
  { id: 'broad_etfs',       label: 'ETFs Amplos',        icon: '🌐' },
]

const DELTA_PROFILES: { id: DeltaProfileFE; label: string }[] = [
  { id: 'conservative', label: 'Conservador Δ 0.15–0.25' },
  { id: 'moderate',     label: 'Moderado Δ 0.25–0.40' },
  { id: 'aggressive',   label: 'Agressivo Δ 0.40–0.50' },
]

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })
}

export function OptionScreenerPanel() {
  const screener = useOptionScreener()
  const isLoading = screener.status === 'scanning'

  return (
    <div className="bg-bg-elevated border border-border-subtle rounded-xl overflow-hidden">
      {/* Header */}
      <div className="bg-card px-4 py-3 border-b border-border-subtle flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-[#00ff88] font-bold text-sm">⚡ Option Screener</span>
          {screener.scanMeta && (
            <span className="text-[10px] text-text-muted">
              {screener.scanMeta.passedFilters} de {screener.scanMeta.totalScanned} · {formatTime(screener.scanMeta.scannedAt)} ET
            </span>
          )}
        </div>

        {/* Preset buttons */}
        <div className="flex gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => screener.runScan(p.id)}
              disabled={isLoading}
              className={`text-[11px] px-2.5 py-1 rounded border transition-colors ${
                screener.activePreset === p.id
                  ? 'bg-[#00ff88]/10 border-[#00ff88]/30 text-[#00ff88]'
                  : 'bg-bg-elevated border-border-subtle text-text-secondary hover:border-border'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {p.icon} {p.label}
            </button>
          ))}
        </div>

        {/* Delta profile selector */}
        <select
          value={screener.deltaProfile}
          onChange={(e) => screener.setDeltaProfile(e.target.value as DeltaProfileFE)}
          className="text-[11px] bg-card border border-border-subtle text-text-primary rounded px-2 py-1"
          disabled={isLoading}
        >
          {DELTA_PROFILES.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>

        {/* Scan button */}
        <button
          onClick={() => screener.runScan()}
          disabled={isLoading}
          className="bg-[#00ff88]/10 border border-[#00ff88]/30 text-[#00ff88] hover:bg-[#00ff88]/20 hover:border-[#00ff88]/50 disabled:bg-bg-elevated disabled:border-border-subtle disabled:text-text-muted disabled:cursor-not-allowed text-[11px] font-bold px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5"
        >
          {isLoading ? (
            <>
              <div className="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
              Varrendo...
            </>
          ) : (
            '▶ Varrer Agora'
          )}
        </button>
      </div>

      {/* Body */}
      {screener.status === 'idle' && screener.candidates.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 gap-3">
          <div className="text-3xl">🔍</div>
          <p className="text-text-secondary text-sm">Clique em um preset ou "Varrer Agora" para iniciar a varredura</p>
          <p className="text-text-muted text-xs">
            {screener.deltaProfile === 'conservative' && 'Perfil conservador · Δ 0.15–0.25 · POP 75–85%'}
            {screener.deltaProfile === 'moderate'     && 'Perfil moderado · Δ 0.25–0.40 · POP 60–75%'}
            {screener.deltaProfile === 'aggressive'   && 'Perfil agressivo · Δ 0.40–0.50 · POP 50–60%'}
          </p>
        </div>
      ) : screener.status === 'error' ? (
        <div className="flex flex-col items-center justify-center py-8 gap-2">
          <p className="text-[#ff4444] text-sm">⚠️ {screener.error}</p>
          <button
            onClick={() => screener.runScan()}
            className="text-xs text-text-secondary underline hover:text-text-primary"
          >
            Tentar novamente
          </button>
        </div>
      ) : (
        <div className="flex" style={{ minHeight: '280px', maxHeight: '480px' }}>
          {/* Left: candidate list */}
          <div className="w-2/5 border-r border-border-subtle overflow-y-auto">
            {screener.status === 'scanning' ? (
              <div className="flex items-center justify-center h-full gap-2 text-text-secondary text-sm">
                <div className="w-4 h-4 rounded-full border-2 border-[#00ff88] border-t-transparent animate-spin" />
                Varrendo ativos...
              </div>
            ) : (
              <CandidateList
                candidates={screener.candidates}
                selectedSymbol={screener.selectedSymbol}
                onSelect={screener.analyzeSymbol}
              />
            )}
          </div>

          {/* Right: deep dive */}
          <div className="w-3/5 overflow-y-auto">
            <DeepDivePanel
              symbol={screener.selectedSymbol}
              deepDive={screener.deepDive}
              strategy={screener.strategy}
              strategyTokens={screener.strategyTokens}
              status={screener.status}
            />
          </div>
        </div>
      )}

      {/* Footer */}
      {screener.candidates.length > 0 && (
        <div className="bg-card border-t border-border-subtle px-4 py-1.5 flex justify-between text-[10px] text-text-muted">
          <span>
            {screener.scanMeta?.totalScanned ?? '?'} tickers varridos ·{' '}
            {screener.scanMeta?.passedFilters ?? 0} passaram nos filtros
            {screener.activePreset && ` · Preset: ${screener.activePreset.replace(/_/g, ' ')}`}
          </span>
          <span className="text-[#00ff88]">● Live</span>
        </div>
      )}
    </div>
  )
}
