import { memo, useMemo, useState, useCallback, useEffect } from 'react'
import { motion } from 'framer-motion'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  LabelList,
} from 'recharts'
import { useMarketStore } from '../../store/marketStore'
import type { GEXProfile, GEXExpirationEntry } from '../../store/marketStore'
import { supabase } from '../../lib/supabase'
import { getApiBase } from '../../lib/apiBase'

function fmtM(v: number): string {
  return `$${Math.abs(v).toFixed(1)}M`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function GEXCustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const callGex = payload.find((p: any) => p.dataKey === 'callGex')?.value ?? 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const putGex = payload.find((p: any) => p.dataKey === 'putGex')?.value ?? 0
  const net = callGex - putGex
  return (
    <div className="bg-bg-elevated border border-border rounded px-2 py-1.5 text-xs pointer-events-none">
      <div className="text-text-secondary mb-1 font-num">Strike {label}</div>
      <div className="text-[#00ff88]">Call: +${callGex.toFixed(1)}M</div>
      <div className="text-red-400">Put: -${putGex.toFixed(1)}M</div>
      <div className={`mt-0.5 font-semibold ${net >= 0 ? 'text-[#00ff88]' : 'text-red-400'}`}>
        Net: {net >= 0 ? '+' : ''}{net.toFixed(1)}M
      </div>
    </div>
  )
}

const REFERENCE_LINES = [
  { color: '#ffffff', label: 'Preço' },
  { color: '#ffcc00', label: 'Flip Point' },
  { color: '#cc44ff', label: 'Put Wall' },
  { color: '#4488ff', label: 'Call Wall' },
  { color: '#00ffcc', label: 'Max Gamma' },
  { color: '#ff8800', label: 'ZGL' },
  { color: '#ff4488', label: 'VT' },
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TermStructureTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload as { label: string; totalGEX: number; regime: string }
  return (
    <div className="bg-bg-elevated border border-border rounded px-2 py-1 text-[10px] pointer-events-none">
      <div className="text-text-primary font-semibold">{d.label}</div>
      <div className={d.regime === 'positive' ? 'text-[#00ff88]' : 'text-red-400'}>
        {d.totalGEX >= 0 ? '+' : ''}{d.totalGEX.toFixed(1)}M
      </div>
    </div>
  )
}

type FlowState = 'idle' | 'streaming' | 'done' | 'error'

export const GEXPanel = memo(function GEXPanel() {
  const gexProfile = useMarketStore((s) => s.gexProfile)
  const gexDynamic = useMarketStore((s) => s.gexDynamic)
  const spyLast = useMarketStore((s) => s.spy.last)
  const vixLast = useMarketStore((s) => s.vix.last)

  const [selectedExpiration, setSelectedExpiration] = useState<string | null>(null)
  const [flowState, setFlowState] = useState<FlowState>('idle')
  const [flowText, setFlowText] = useState('')

  // Auto-select entry with highest gammaAnomaly when gexDynamic arrives or changes
  useEffect(() => {
    if (!gexDynamic || gexDynamic.length === 0) return
    const peak = gexDynamic.reduce((best, e) => e.gammaAnomaly > best.gammaAnomaly ? e : best, gexDynamic[0])
    setSelectedExpiration((prev) => {
      // Keep current selection if it still exists in the new data
      if (prev && gexDynamic.some((e) => e.expiration === prev)) return prev
      return peak.expiration
    })
  }, [gexDynamic])

  const activeEntry: GEXExpirationEntry | null = useMemo(() =>
    gexDynamic?.find((e) => e.expiration === selectedExpiration) ?? null,
    [gexDynamic, selectedExpiration],
  )

  const activeGex: GEXProfile | null = useMemo(() => {
    if (activeEntry) return activeEntry.gex
    return gexProfile
  }, [activeEntry, gexProfile])

  const chartData = useMemo(() => {
    if (!activeGex || !spyLast) return []
    return activeGex.byStrike
      .filter((s) => Math.abs(s.strike - spyLast) <= 15)
      .sort((a, b) => a.strike - b.strike)
      .map((s) => ({
        strike: s.strike,
        callGex: s.callGEX,
        putGex: Math.abs(s.putGEX),
        netGex: s.netGEX,
      }))
  }, [activeGex, spyLast])

  const analyzeFlow = useCallback(async () => {
    if (!activeGex || !spyLast) return

    setFlowState('streaming')
    setFlowText('')

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const authHeader = session?.access_token ? `Bearer ${session.access_token}` : ''

      const res = await fetch(`${getApiBase()}/api/analyze/gex-flow`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify({
          selectedDte: activeEntry?.label ?? selectedExpiration ?? 'ALL',
          gexData: {
            totalNetGamma: activeGex.totalGEX,
            callWall: activeGex.callWall,
            putWall: activeGex.putWall,
            maxGexStrike: activeGex.maxGammaStrike,
            minGexStrike: activeGex.minGammaStrike,
            flipPoint: activeGex.flipPoint,
            zeroGammaLevel: activeGex.zeroGammaLevel,
            regime: activeGex.regime,
            expiration: selectedExpiration ?? activeGex.calculatedAt,
            profile: { byStrike: activeGex.byStrike },
            calculatedAt: activeGex.calculatedAt,
          },
          spyLast,
          vixLast,
        }),
      })

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event: done')) {
            setFlowState('done')
          }
          if (line.startsWith('event: error')) {
            setFlowState('error')
          }
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6)) as { text?: string }
              if (parsed.text) setFlowText((prev) => prev + parsed.text)
            } catch {
              // skip
            }
          }
        }
      }

      setFlowState((s) => s === 'streaming' ? 'done' : s)
    } catch {
      setFlowState('error')
    }
  }, [activeGex, activeEntry, selectedExpiration, spyLast, vixLast])

  if (!gexProfile) {
    return (
      <motion.section
        className="card opacity-50"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 0.5, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-display font-bold text-text-primary tracking-wide">
            Gamma Exposure (GEX)
          </span>
          <span className="text-[10px] text-text-muted">Desabilitado</span>
        </div>
        <p className="text-xs text-text-secondary leading-relaxed">
          GEX requer dados de open interest via Tradier API.{' '}
          Adicione{' '}
          <code className="text-[11px] bg-surface-2 px-1 rounded">TRADIER_API_KEY=&lt;key&gt;</code>{' '}
          no <code className="text-[11px] bg-surface-2 px-1 rounded">backend/.env</code> e reinicie o servidor.{' '}
          Conta gratuita em{' '}
          <span className="text-text-primary font-medium">tradier.com</span>.
        </p>
      </motion.section>
    )
  }

  const isPositive = activeGex?.regime === 'positive'
  const regimeColor = isPositive ? 'text-[#00ff88]' : 'text-red-400'
  const regimeLabel = isPositive ? 'POSITIVO' : 'NEGATIVO'
  const regimeDesc = isPositive
    ? 'MMs suprimem volatilidade'
    : 'MMs amplificam volatilidade'

  const currentPriceStrike = spyLast != null ? Math.round(spyLast) : null

  return (
    <motion.section
      className="card"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-display font-bold text-text-primary tracking-wide">
            Gamma Exposure (GEX)
          </span>
          {activeGex && (
            <span className={`text-[10px] font-semibold tracking-widest uppercase ${regimeColor}`}>
              {regimeLabel}
            </span>
          )}
        </div>
        {activeGex && (
          <span className="text-[10px] text-text-muted">
            {new Date(activeGex.calculatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>

      {/* Mini Term Structure Curve */}
      {gexDynamic && gexDynamic.length > 0 && (
        <div className="mb-3" style={{ height: 90 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={gexDynamic.map((e) => ({
                label: e.label,
                shortLabel: e.label.slice(0, 6),
                expiration: e.expiration,
                totalGEX: e.gex.totalGEX,
                regime: e.gex.regime,
                gammaAnomaly: e.gammaAnomaly,
              }))}
              margin={{ top: 4, right: 4, left: 0, bottom: 16 }}
              barCategoryGap="15%"
              onClick={(d) => {
                if (d?.activePayload?.[0]?.payload?.expiration) {
                  setSelectedExpiration(d.activePayload[0].payload.expiration)
                  setFlowText('')
                  setFlowState('idle')
                }
              }}
            >
              <XAxis dataKey="shortLabel" tick={{ fill: '#8888aa', fontSize: 7 }} axisLine={false} tickLine={false} />
              <YAxis hide domain={['auto', 'auto']} />
              <Tooltip content={<TermStructureTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <Bar dataKey="totalGEX" maxBarSize={32} isAnimationActive={false} radius={[2, 2, 0, 0]}>
                {gexDynamic.map((entry) => (
                  <Cell
                    key={entry.expiration}
                    fill={entry.gex.regime === 'positive' ? '#00ff88' : '#ff4444'}
                    fillOpacity={entry.expiration === selectedExpiration ? 1 : 0.4}
                    stroke={entry.expiration === selectedExpiration ? (entry.gex.regime === 'positive' ? '#00ff88' : '#ff4444') : 'none'}
                    strokeWidth={entry.expiration === selectedExpiration ? 1.5 : 0}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Expiration dropdown + anomaly badge + Analisar Fluxo button */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          {gexDynamic && gexDynamic.length > 0 ? (
            <select
              value={selectedExpiration ?? ''}
              onChange={(e) => { setSelectedExpiration(e.target.value); setFlowText(''); setFlowState('idle') }}
              className="bg-bg-elevated border border-border-subtle text-text-primary text-[11px] rounded px-2 py-1 cursor-pointer focus:outline-none focus:border-[#00ff88]/40 max-w-[220px] truncate"
            >
              {gexDynamic.map((entry) => (
                <option key={entry.expiration} value={entry.expiration}>
                  {entry.label}{entry.gammaAnomaly > 0.7 ? ' ⚡' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[11px] text-text-muted">—</span>
          )}
          {activeEntry && (
            <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wider ${
              activeEntry.gammaAnomaly > 0.7
                ? 'bg-yellow-400/10 text-yellow-400'
                : activeEntry.gammaAnomaly > 0.4
                ? 'bg-blue-400/10 text-blue-400'
                : 'bg-surface-2 text-text-muted'
            }`}>
              {activeEntry.gammaAnomaly > 0.7 ? '⚡ Alta' : activeEntry.gammaAnomaly > 0.4 ? 'Média' : 'Baixa'}
            </span>
          )}
        </div>
        <button
          onClick={analyzeFlow}
          disabled={flowState === 'streaming' || !activeGex}
          className={`self-start sm:self-auto shrink-0 px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-200 whitespace-nowrap ${
            flowState === 'streaming' || !activeGex
              ? 'bg-bg-elevated text-text-muted cursor-not-allowed border border-border-subtle'
              : 'bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/30 hover:bg-[#00ff88]/20 hover:border-[#00ff88]/50 active:scale-95'
          }`}
        >
          {flowState === 'streaming' ? (
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
              Analisando...
            </span>
          ) : (
            'Analisar Fluxo'
          )}
        </button>
      </div>

      {/* No data for selected DTE */}
      {!activeGex && (
        <p className="text-xs text-text-secondary mb-4">Sem dados para este vencimento.</p>
      )}

      {activeGex && (
        <>
          {/* Metrics grid — linha 1: níveis de preço · linha 2: estrutura do regime */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">

            {/* ── Linha 1: Níveis de preço ── */}

            {/* GEX Total */}
            <div className="bg-bg-elevated rounded px-3 py-2">
              <div className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">GEX Total</div>
              <div className={`text-sm font-bold font-num ${regimeColor}`}>
                {activeGex.totalGEX >= 0 ? '+' : ''}{fmtM(activeGex.totalGEX)}
              </div>
              <div className={`text-[9px] font-semibold mt-0.5 ${regimeColor}`}>
                {isPositive ? 'Long Gamma' : 'Short Gamma'}
              </div>
            </div>

            {/* Flip Point */}
            <div className="bg-bg-elevated rounded px-3 py-2">
              <div className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">Flip Point</div>
              <div className="text-sm font-bold font-num text-[#ffcc00]">
                {activeGex.flipPoint != null ? `$${activeGex.flipPoint}` : '—'}
              </div>
              {activeGex.flipPoint != null && spyLast != null && (
                <div className={`text-[9px] font-semibold mt-0.5 ${spyLast > activeGex.flipPoint ? 'text-[#00ff88]/70' : 'text-red-400/70'}`}>
                  {spyLast > activeGex.flipPoint ? '▲ ACIMA' : '▼ ABAIXO'}
                </div>
              )}
            </div>

            {/* Volatility Trigger */}
            {activeGex.volatilityTrigger != null ? (() => {
              const vt = activeGex.volatilityTrigger!
              const above = spyLast != null && spyLast > vt
              const distPct = spyLast != null ? Math.abs((spyLast - vt) / vt * 100).toFixed(2) : null
              return (
                <div className="bg-bg-elevated rounded px-3 py-2">
                  <div className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">Vol. Trigger</div>
                  <div className={`text-sm font-bold font-num ${above ? 'text-[#00ff88]' : 'text-red-400'}`}>
                    ${vt.toFixed(2)}
                  </div>
                  {distPct != null && (
                    <div className={`text-[9px] font-semibold mt-0.5 ${above ? 'text-[#00ff88]/70' : 'text-red-400/70'}`}>
                      {above ? '▲' : '▼'} {distPct}% {above ? 'ACIMA' : 'ABAIXO'}
                    </div>
                  )}
                </div>
              )
            })() : (
              <div className="bg-bg-elevated rounded px-3 py-2 opacity-40">
                <div className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">Vol. Trigger</div>
                <div className="text-sm text-text-muted">—</div>
              </div>
            )}

            {/* Zero Gamma Level */}
            {activeGex.zeroGammaLevel != null && spyLast != null ? (() => {
              const zgl = activeGex.zeroGammaLevel!
              const distPct = ((spyLast - zgl) / zgl * 100)
              return (
                <div className="bg-bg-elevated rounded px-3 py-2">
                  <div className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">Zero Gamma</div>
                  <div className="text-sm font-bold font-num text-[#ff8800]">${zgl.toFixed(2)}</div>
                  <div className="text-[9px] text-[#ff8800]/70 font-semibold mt-0.5">
                    {distPct >= 0 ? '+' : ''}{distPct.toFixed(2)}% do SPY
                  </div>
                </div>
              )
            })() : (
              <div className="bg-bg-elevated rounded px-3 py-2 opacity-40">
                <div className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">Zero Gamma</div>
                <div className="text-sm text-text-muted">—</div>
              </div>
            )}

            {/* ── Linha 2: Estrutura do regime ── */}

            {/* Max Gamma */}
            <div className="bg-bg-elevated rounded px-3 py-2">
              <div className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">Max Gamma</div>
              <div className="text-sm font-bold font-num text-[#00ffcc]">${activeGex.maxGammaStrike}</div>
              <div className="text-[9px] text-text-muted mt-0.5">Strike</div>
            </div>

            {/* Max Pain */}
            {activeGex.maxPain ? (() => {
              const mp = activeGex.maxPain!
              const pinColor = mp.pinRisk === 'high' ? '#ff4444' : mp.pinRisk === 'moderate' ? '#ffcc00' : '#888888'
              const abovePain = mp.distanceFromSpot < 0
              return (
                <div className="bg-bg-elevated rounded px-3 py-2">
                  <div className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">Max Pain</div>
                  <div className="text-sm font-bold font-num" style={{ color: pinColor }}>${mp.maxPainStrike}</div>
                  <div className="text-[9px] font-semibold mt-0.5" style={{ color: pinColor }}>
                    {abovePain ? '▼' : '▲'} {Math.abs(mp.distancePct).toFixed(2)}% · {mp.pinRisk === 'high' ? 'ALTO' : mp.pinRisk === 'moderate' ? 'MOD' : 'BAIXO'}
                  </div>
                </div>
              )
            })() : (
              <div className="bg-bg-elevated rounded px-3 py-2 opacity-40">
                <div className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">Max Pain</div>
                <div className="text-sm text-text-muted">—</div>
              </div>
            )}

            {/* Vanna (VEX) */}
            <div className="bg-bg-elevated rounded px-3 py-2">
              <div className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">Vanna (VEX)</div>
              {activeGex.totalVannaExposure != null ? (
                <>
                  <div className={`text-sm font-bold font-num ${
                    activeGex.totalVannaExposure < -5 ? 'text-red-400'
                    : activeGex.totalVannaExposure > 2 ? 'text-[#00ff88]'
                    : 'text-text-primary'
                  }`}>
                    {activeGex.totalVannaExposure >= 0 ? '+' : ''}${activeGex.totalVannaExposure.toFixed(1)}M
                  </div>
                  <div className="text-[9px] text-text-muted mt-0.5">
                    {activeGex.totalVannaExposure < -5 ? 'Bearish' : activeGex.totalVannaExposure > 2 ? 'Bullish' : 'Neutro'}
                  </div>
                </>
              ) : (
                <div className="text-xs text-text-muted italic mt-0.5">Aguardando...</div>
              )}
            </div>

            {/* Charm (CEX) */}
            <div className="bg-bg-elevated rounded px-3 py-2">
              <div className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">Charm (CEX)</div>
              {activeGex.totalCharmExposure != null ? (
                <>
                  <div className={`text-sm font-bold font-num ${
                    Math.abs(activeGex.totalCharmExposure) > 1 ? 'text-[#00ff88]' : 'text-text-primary'
                  }`}>
                    {activeGex.totalCharmExposure >= 0 ? '+' : ''}${activeGex.totalCharmExposure.toFixed(1)}M/dia
                  </div>
                  <div className="text-[9px] text-text-muted mt-0.5">
                    {Math.abs(activeGex.totalCharmExposure) > 1 ? 'Pressão' : Math.abs(activeGex.totalCharmExposure) > 0.5 ? 'Moderada' : 'Neutro'}
                  </div>
                </>
              ) : (
                <div className="text-xs text-text-muted italic mt-0.5">Aguardando...</div>
              )}
            </div>

          </div>

          {/* Recharts bar chart */}
          {chartData.length > 0 ? (
            <div className="border-t border-border-subtle pt-3" style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  barGap={1}
                  barCategoryGap="20%"
                  margin={{ top: 28, right: 12, left: 0, bottom: 4 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="rgba(255,255,255,0.04)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="strike"
                    tick={{ fill: '#8888aa', fontSize: 9 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: '#8888aa', fontSize: 9 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `$${v}M`}
                    width={44}
                  />
                  <Tooltip
                    content={<GEXCustomTooltip />}
                    cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                  />

                  {/* Call bars — green, orange on maxGammaStrike */}
                  <Bar
                    dataKey="callGex"
                    name="Call GEX"
                    fill="#00ff88"
                    fillOpacity={0.75}
                    maxBarSize={18}
                    isAnimationActive={false}
                  >
                    {chartData.map((entry, index) => (
                      <Cell
                        key={`call-${index}`}
                        fill={entry.strike === activeGex!.maxGammaStrike ? '#ff9900' : '#00ff88'}
                        fillOpacity={entry.strike === activeGex!.maxGammaStrike ? 0.95 : 0.75}
                      />
                    ))}
                    <LabelList
                      dataKey="callGex"
                      position="top"
                      formatter={(v: number) => (v > 0.5 ? `$${v.toFixed(1)}` : '')}
                      fill="#00ff88"
                      fontSize={7}
                    />
                  </Bar>

                  {/* Put bars — red, orange on maxGammaStrike */}
                  <Bar
                    dataKey="putGex"
                    name="Put GEX"
                    fill="#ff4444"
                    fillOpacity={0.65}
                    maxBarSize={18}
                    isAnimationActive={false}
                  >
                    {chartData.map((entry, index) => (
                      <Cell
                        key={`put-${index}`}
                        fill={entry.strike === activeGex!.maxGammaStrike ? '#ff6600' : '#ff4444'}
                        fillOpacity={entry.strike === activeGex!.maxGammaStrike ? 0.95 : 0.65}
                      />
                    ))}
                    <LabelList
                      dataKey="putGex"
                      position="top"
                      formatter={(v: number) => (v > 0.5 ? `$${v.toFixed(1)}` : '')}
                      fill="#ff7777"
                      fontSize={7}
                    />
                  </Bar>

                  {/* Current price */}
                  {currentPriceStrike != null && (
                    <ReferenceLine
                      x={currentPriceStrike}
                      stroke="#ffffff"
                      strokeWidth={1.5}
                      strokeDasharray="4 2"
                      label={{
                        value: `Preço $${spyLast!.toFixed(0)}`,
                        position: 'insideTopRight',
                        fill: '#ffffff',
                        fontSize: 9,
                      }}
                    />
                  )}

                  {/* Flip Point */}
                  {activeGex.flipPoint != null && (
                    <ReferenceLine
                      x={activeGex.flipPoint}
                      stroke="#ffcc00"
                      strokeWidth={1}
                      strokeDasharray="4 2"
                      label={{
                        value: `Flip ${activeGex.flipPoint}`,
                        position: 'insideTopLeft',
                        fill: '#ffcc00',
                        fontSize: 9,
                      }}
                    />
                  )}

                  {/* Put Wall */}
                  <ReferenceLine
                    x={activeGex.putWall}
                    stroke="#cc44ff"
                    strokeWidth={1}
                    strokeDasharray="4 2"
                    label={{
                      value: `Put Wall ${activeGex.putWall}`,
                      position: 'insideTopLeft',
                      fill: '#cc44ff',
                      fontSize: 9,
                    }}
                  />

                  {/* Call Wall */}
                  <ReferenceLine
                    x={activeGex.callWall}
                    stroke="#4488ff"
                    strokeWidth={1}
                    strokeDasharray="4 2"
                    label={{
                      value: `Call Wall ${activeGex.callWall}`,
                      position: 'insideTopRight',
                      fill: '#4488ff',
                      fontSize: 9,
                    }}
                  />

                  {/* Max Gamma Strike */}
                  <ReferenceLine
                    x={activeGex.maxGammaStrike}
                    stroke="#00ffcc"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                    label={{
                      value: `Max γ ${activeGex.maxGammaStrike}`,
                      position: 'insideTopRight',
                      fill: '#00ffcc',
                      fontSize: 9,
                    }}
                  />

                  {/* Zero Gamma Level */}
                  {activeGex.zeroGammaLevel != null && (
                    <ReferenceLine
                      x={activeGex.zeroGammaLevel}
                      stroke="#ff8800"
                      strokeWidth={1.5}
                      strokeDasharray="4 2"
                      label={{
                        value: `ZGL ${activeGex.zeroGammaLevel.toFixed(1)}`,
                        position: 'insideTopLeft',
                        fill: '#ff8800',
                        fontSize: 9,
                      }}
                    />
                  )}

                  {/* Volatility Trigger */}
                  {activeGex.volatilityTrigger != null && (
                    <ReferenceLine
                      x={activeGex.volatilityTrigger}
                      stroke="#ff4488"
                      strokeWidth={1.5}
                      strokeDasharray="6 3"
                      label={{
                        value: `VT ${activeGex.volatilityTrigger.toFixed(1)}`,
                        position: 'insideTopRight',
                        fill: '#ff4488',
                        fontSize: 9,
                      }}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-xs text-text-secondary border-t border-border-subtle pt-3">
              Sem dados próximos ao ATM para este vencimento.
            </p>
          )}

          {/* Legend for reference lines */}
          {chartData.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
              {REFERENCE_LINES.map(({ color, label }) => (
                <span key={label} className="flex items-center gap-1 text-[9px] text-text-muted">
                  <span
                    className="inline-block w-4 border-t border-dashed"
                    style={{ borderColor: color }}
                  />
                  {label}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {/* GEX Flow analysis output */}
      {flowText && (
        <div className="mt-4 border-t border-border-subtle pt-3">
          <div className="text-[10px] text-text-muted uppercase tracking-wider mb-2">
            Análise de Fluxo — {activeEntry?.label ?? selectedExpiration ?? ''}
          </div>
          <div className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">
            {flowText}
            {flowState === 'streaming' && (
              <span className="inline-block w-1.5 h-3 bg-[#00ff88] ml-0.5 animate-pulse align-middle" />
            )}
          </div>
          {flowState === 'error' && (
            <p className="text-xs text-red-400 mt-1">Falha ao gerar análise. Tente novamente.</p>
          )}
        </div>
      )}
    </motion.section>
  )
})
