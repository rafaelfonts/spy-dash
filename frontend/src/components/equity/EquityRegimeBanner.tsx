// frontend/src/components/equity/EquityRegimeBanner.tsx
import { useMarketStore } from '../../store/marketStore'

const VIX_REGIME_CONFIG: Record<string, { label: string; color: string }> = {
  calm:     { label: 'VIX Calmo',   color: '#00ff88' },
  elevated: { label: 'VIX Elevado', color: '#ffcc00' },
  crisis:   { label: 'VIX Crise',   color: '#ff4444' },
}

const CATEGORY_LABELS: Record<string, string> = {
  defensive:  'DEF',
  aggressive: 'AGG',
  etf:        'ETF',
}

const CATEGORY_COLORS: Record<string, string> = {
  defensive:  '#4488ff',
  aggressive: '#00ff88',
  etf:        '#ffcc00',
}

const MODE_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  full:           { label: 'FULL',      color: '#00ff88', bg: 'rgba(0,255,136,0.08)' },
  defensive_only: { label: 'DEFENSIVE', color: '#ffcc00', bg: 'rgba(255,204,0,0.08)' },
  suspended:      { label: 'SUSPENSO',  color: '#ff4444', bg: 'rgba(255,68,68,0.08)' },
}

export function EquityRegimeBanner() {
  const equityRegimeState = useMarketStore((s) => s.equityRegimeState)
  if (!equityRegimeState) return null

  const { vixRegime, geoRiskScore, activeCategories, mode, suspendedReason } = equityRegimeState
  const vixCfg = VIX_REGIME_CONFIG[vixRegime] ?? VIX_REGIME_CONFIG.calm
  const modeCfg = MODE_CONFIG[mode] ?? MODE_CONFIG.full

  const geoBarWidth = Math.min(100, Math.max(0, geoRiskScore))
  const geoBarColor = geoRiskScore >= 56 ? '#ff4444' : geoRiskScore >= 31 ? '#ffcc00' : '#00ff88'

  return (
    <div
      className="rounded-lg border border-border-subtle px-3 py-2 mb-3 text-xs"
      style={{ background: modeCfg.bg, borderColor: modeCfg.color + '40' }}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {/* Mode badge */}
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] font-bold px-2 py-0.5 rounded"
            style={{ color: modeCfg.color, background: modeCfg.color + '20', border: `1px solid ${modeCfg.color}40` }}
          >
            {modeCfg.label}
          </span>
          {suspendedReason && (
            <span className="text-text-muted text-[10px] truncate max-w-[160px]">{suspendedReason}</span>
          )}
        </div>

        {/* VIX regime */}
        <div className="flex items-center gap-1">
          <span className="text-text-muted">Regime:</span>
          <span style={{ color: vixCfg.color }} className="font-semibold">{vixCfg.label}</span>
        </div>

        {/* GeoRisk bar */}
        <div className="flex items-center gap-1.5">
          <span className="text-text-muted">GeoRisk:</span>
          <div className="flex items-center gap-1">
            <div className="w-16 h-1.5 rounded-full bg-bg-elevated overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${geoBarWidth}%`, background: geoBarColor }}
              />
            </div>
            <span style={{ color: geoBarColor }} className="text-[10px] font-mono">{geoRiskScore}</span>
          </div>
        </div>

        {/* Active category badges */}
        {activeCategories.length > 0 && (
          <div className="flex items-center gap-1">
            {activeCategories.map((cat) => (
              <span
                key={cat}
                className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                style={{
                  color: CATEGORY_COLORS[cat],
                  background: CATEGORY_COLORS[cat] + '20',
                  border: `1px solid ${CATEGORY_COLORS[cat]}40`,
                }}
              >
                {CATEGORY_LABELS[cat]}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
