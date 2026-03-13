/**
 * SignalPerformanceCard — Backtesting dashboard for scheduled signals.
 *
 * Fetches /api/signal-metrics on mount and displays:
 *  - Overall win rate + avoid accuracy (header stats)
 *  - Win rate by regime band (high/medium/low) with fill bars
 *  - Recent signals table (last 10 rows)
 *
 * Refreshed every 5 minutes so EOD outcomes appear without page reload.
 */

import { useEffect, useState, useCallback } from 'react'
import { getApiBase } from '../../lib/apiBase'
import { supabase } from '../../lib/supabase'

// ---------------------------------------------------------------------------
// Types (mirrors SignalMetrics from signalLogger.ts)
// ---------------------------------------------------------------------------

interface BandStats {
  count: number
  winRate: number | null
}

interface RecentSignal {
  signal_date: string
  slot: string
  trade_signal: 'trade' | 'wait' | 'avoid'
  regime_score: number
  spy_price_at_signal: number | null
  spy_close: number | null
  spy_change_pct: number | null
  outcome: 'profit' | 'loss' | 'neutral' | 'pending' | null
}

interface SignalMetrics {
  totalSignals: number
  tradedSignals: number
  overallWinRate: number | null
  avoidAccuracy: number | null
  avgRegimeScore: number | null
  byRegimeBand: { high: BandStats; medium: BandStats; low: BandStats }
  recentSignals: RecentSignal[]
}

interface CalibrationResult {
  n: number
  regimeScoreCoeff: number
  regimeScoreTStat: number
  r2: number
  interpretation: string
  suggestedAdjustment: {
    direction: 'increase_threshold' | 'decrease_threshold' | 'ok'
    reason: string
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(v: number | null, decimals = 0): string {
  if (v == null) return '–'
  return (v * 100).toFixed(decimals) + '%'
}

function outcomeColor(outcome: RecentSignal['outcome']): string {
  switch (outcome) {
    case 'profit':  return 'text-[#00ff88]'
    case 'loss':    return 'text-red-400'
    case 'pending': return 'text-yellow-400'
    default:        return 'text-text-muted'
  }
}

function signalBadgeClass(ts: RecentSignal['trade_signal']): string {
  switch (ts) {
    case 'trade':  return 'bg-emerald-500/15 text-[#00ff88] border-emerald-500/25'
    case 'avoid':  return 'bg-red-500/15 text-red-400 border-red-500/25'
    default:       return 'bg-yellow-500/15 text-yellow-400 border-yellow-500/25'
  }
}

function WinRateBar({ rate, count }: { rate: number | null; count: number }) {
  if (count === 0) {
    return <span className="text-[10px] text-text-muted">sem dados</span>
  }
  const fill = rate != null ? Math.round(rate * 100) : 0
  const color = fill >= 60 ? '#00ff88' : fill >= 40 ? '#facc15' : '#f87171'

  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-1.5 bg-bg-surface rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${fill}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-[10px] font-num text-text-secondary w-10 text-right">
        {rate != null ? `${fill}%` : '–'} <span className="text-text-muted">({count})</span>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SignalPerformanceCard() {
  const [metrics, setMetrics] = useState<SignalMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [calibration, setCalibration] = useState<CalibrationResult | null>(null)
  const [calibOpen, setCalibOpen] = useState(false)
  const [calibLoading, setCalibLoading] = useState(false)

  const fetchCalibration = useCallback(async () => {
    setCalibLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch(`${getApiBase()}/api/signal-metrics/calibration`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.status === 204) { setCalibration(null); return }
      if (!res.ok) return
      setCalibration(await res.json())
    } finally {
      setCalibLoading(false)
    }
  }, [])

  const handleCalibToggle = useCallback(() => {
    const opening = !calibOpen
    setCalibOpen(opening)
    if (opening && !calibration) fetchCalibration()
  }, [calibOpen, calibration, fetchCalibration])

  const fetchMetrics = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return
    try {
      const res = await fetch(`${getApiBase()}/api/signal-metrics?days=30`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.status === 204) {
        setMetrics(null)
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: SignalMetrics = await res.json()
      setMetrics(data)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMetrics()
    const interval = setInterval(fetchMetrics, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchMetrics])

  if (loading) {
    return (
      <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-3 text-[11px] text-text-muted">
        Carregando histórico de sinais...
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-3 text-[11px] text-red-400">
        Erro ao carregar métricas: {error}
      </div>
    )
  }

  if (!metrics) {
    return (
      <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-3 text-[11px] text-text-muted">
        Dados insuficientes para backtesting — sinais sendo acumulados.
      </div>
    )
  }

  const { byRegimeBand: b, recentSignals } = metrics

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card">
      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-bg-surface/30 transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-wide text-text-muted">Performance Sinais (30d)</span>
          {metrics.totalSignals > 0 && (
            <span className="text-[10px] text-text-muted">{metrics.totalSignals} sinais</span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {/* Win rate pill */}
          {metrics.overallWinRate != null && (
            <span className={`text-xs font-semibold ${metrics.overallWinRate >= 0.6 ? 'text-[#00ff88]' : metrics.overallWinRate >= 0.4 ? 'text-yellow-400' : 'text-red-400'}`}>
              {pct(metrics.overallWinRate)} W/R
            </span>
          )}
          <span className="text-text-muted text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-border-subtle pt-3">

          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center">
              <div className="text-[10px] text-text-muted mb-0.5">Win Rate (trade)</div>
              <div className={`text-base font-semibold font-num ${metrics.overallWinRate != null && metrics.overallWinRate >= 0.6 ? 'text-[#00ff88]' : 'text-yellow-400'}`}>
                {pct(metrics.overallWinRate, 1)}
              </div>
              <div className="text-[9px] text-text-muted">{metrics.tradedSignals} sinais trade</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-text-muted mb-0.5">Avoid Accuracy</div>
              <div className={`text-base font-semibold font-num ${metrics.avoidAccuracy != null && metrics.avoidAccuracy >= 0.6 ? 'text-[#00ff88]' : 'text-text-secondary'}`}>
                {pct(metrics.avoidAccuracy, 1)}
              </div>
              <div className="text-[9px] text-text-muted">vetos corretos</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-text-muted mb-0.5">Avg Regime (trade)</div>
              <div className="text-base font-semibold font-num text-text-primary">
                {metrics.avgRegimeScore != null ? `${metrics.avgRegimeScore}/10` : '–'}
              </div>
              <div className="text-[9px] text-text-muted">score médio</div>
            </div>
          </div>

          {/* Win rate by regime band */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-text-muted mb-2">Win Rate por Regime Band</div>
            <div className="space-y-1.5">
              {[
                { label: 'Alto (7–10)', data: b.high },
                { label: 'Médio (4–6)', data: b.medium },
                { label: 'Baixo (0–3)', data: b.low },
              ].map(({ label, data }) => (
                <div key={label} className="flex items-center justify-between gap-3">
                  <span className="text-[10px] text-text-secondary w-20 shrink-0">{label}</span>
                  <WinRateBar rate={data.winRate} count={data.count} />
                </div>
              ))}
            </div>
          </div>

          {/* Recent signals table */}
          {recentSignals.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-text-muted mb-2">Últimos Sinais</div>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="text-text-muted border-b border-border-subtle">
                      <th className="text-left pb-1 pr-2">Data</th>
                      <th className="text-left pb-1 pr-2">Slot</th>
                      <th className="text-left pb-1 pr-2">Sinal</th>
                      <th className="text-right pb-1 pr-2">Reg.</th>
                      <th className="text-right pb-1 pr-2">Δ%</th>
                      <th className="text-right pb-1">Resultado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentSignals.map((s, i) => (
                      <tr key={i} className="border-b border-border-subtle/40 hover:bg-bg-surface/20">
                        <td className="py-1 pr-2 text-text-muted">
                          {s.signal_date.slice(5)}
                        </td>
                        <td className="py-1 pr-2 text-text-muted">{s.slot}</td>
                        <td className="py-1 pr-2">
                          <span className={`px-1 py-0.5 rounded border text-[9px] font-bold ${signalBadgeClass(s.trade_signal)}`}>
                            {s.trade_signal.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-1 pr-2 text-right font-num text-text-secondary">
                          {s.regime_score}/10
                        </td>
                        <td className={`py-1 pr-2 text-right font-num ${s.spy_change_pct != null && s.spy_change_pct >= 0 ? 'text-[#00ff88]' : 'text-red-400'}`}>
                          {s.spy_change_pct != null
                            ? `${s.spy_change_pct >= 0 ? '+' : ''}${s.spy_change_pct.toFixed(2)}%`
                            : '–'}
                        </td>
                        <td className={`py-1 text-right font-num font-semibold ${outcomeColor(s.outcome)}`}>
                          {s.outcome === 'pending' ? '⏳' :
                           s.outcome === 'profit' ? '✓' :
                           s.outcome === 'loss' ? '✗' :
                           '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Calibração OLS — collapsible */}
          <div className="border-t border-border-subtle pt-3">
            <button
              type="button"
              onClick={handleCalibToggle}
              className="w-full flex items-center justify-between text-[10px] uppercase tracking-wide text-text-muted hover:text-text-secondary transition-colors"
            >
              <span>Calibração OLS (regime_score)</span>
              <span>{calibOpen ? '▲' : '▼'}</span>
            </button>

            {calibOpen && (
              <div className="mt-2">
                {calibLoading && !calibration ? (
                  <p className="text-[10px] text-text-muted">Calculando OLS...</p>
                ) : !calibration ? (
                  <p className="text-[10px] text-text-muted">
                    Dados insuficientes — mínimo 30 sinais resolvidos (trade: profit/loss).
                  </p>
                ) : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        {
                          label: 'β(regime_score)',
                          value: (calibration.regimeScoreCoeff >= 0 ? '+' : '') + calibration.regimeScoreCoeff.toFixed(4),
                          color: calibration.regimeScoreCoeff > 0 ? 'text-[#00ff88]' : 'text-red-400',
                        },
                        {
                          label: 't-stat',
                          value: (calibration.regimeScoreTStat >= 0 ? '+' : '') + calibration.regimeScoreTStat.toFixed(2)
                            + (Math.abs(calibration.regimeScoreTStat) >= 1.96 ? '*' : ''),
                          color: Math.abs(calibration.regimeScoreTStat) >= 1.96 ? 'text-[#00ff88]' : 'text-yellow-400',
                        },
                        {
                          label: 'R²',
                          value: calibration.r2.toFixed(3),
                          color: calibration.r2 >= 0.1 ? 'text-text-secondary' : 'text-text-muted',
                        },
                      ].map(({ label, value, color }) => (
                        <div key={label} className="rounded bg-bg-elevated border border-border-subtle px-2 py-1.5 text-center">
                          <p className="text-[8px] text-text-muted mb-0.5">{label}</p>
                          <p className={`text-xs font-bold font-num ${color}`}>{value}</p>
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-text-secondary leading-relaxed">
                      {calibration.interpretation}
                    </p>
                    {calibration.suggestedAdjustment.direction !== 'ok' && (
                      <p className="text-[10px] text-yellow-400 bg-yellow-500/5 border border-yellow-500/20 rounded px-2 py-1.5 leading-relaxed">
                        ⚠ {calibration.suggestedAdjustment.reason}
                      </p>
                    )}
                    <p className="text-[9px] text-text-muted">n={calibration.n} sinais (trade: profit/loss)</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
