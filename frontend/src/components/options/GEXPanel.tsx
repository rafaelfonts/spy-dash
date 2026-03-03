import { memo, useMemo, useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  LabelList,
} from 'recharts'
import { useMarketStore } from '../../store/marketStore'
import type { GEXProfile } from '../../store/marketStore'
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
]

type DteKey = '0DTE' | '1D' | '7D' | '21D' | '45D' | 'ALL'

const DTE_TABS: { key: DteKey; label: string }[] = [
  { key: '0DTE', label: '0DTE' },
  { key: '1D',   label: '1D' },
  { key: '7D',   label: '7D' },
  { key: '21D',  label: '21D' },
  { key: '45D',  label: '45D' },
  { key: 'ALL',  label: 'ALL' },
]

type FlowState = 'idle' | 'streaming' | 'done' | 'error'

export const GEXPanel = memo(function GEXPanel() {
  const gexProfile = useMarketStore((s) => s.gexProfile)
  const gexByExpiration = useMarketStore((s) => s.gexByExpiration)
  const spyLast = useMarketStore((s) => s.spy.last)
  const vixLast = useMarketStore((s) => s.vix.last)

  const [selectedDte, setSelectedDte] = useState<DteKey>('0DTE')
  const [flowState, setFlowState] = useState<FlowState>('idle')
  const [flowText, setFlowText] = useState('')

  // Resolve which GEXProfile to display based on the selected DTE tab
  const activeGex: GEXProfile | null = useMemo(() => {
    if (selectedDte === '0DTE') return gexProfile
    if (!gexByExpiration) return null
    const keyMap: Record<DteKey, keyof typeof gexByExpiration> = {
      '0DTE': 'dte0',
      '1D':   'dte1',
      '7D':   'dte7',
      '21D':  'dte21',
      '45D':  'dte45',
      'ALL':  'all',
    }
    return gexByExpiration[keyMap[selectedDte]]
  }, [selectedDte, gexProfile, gexByExpiration])

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
          selectedDte,
          gexData: {
            totalNetGamma: activeGex.totalGEX,
            callWall: activeGex.callWall,
            putWall: activeGex.putWall,
            maxGexStrike: activeGex.maxGammaStrike,
            minGexStrike: activeGex.minGammaStrike,
            flipPoint: activeGex.flipPoint,
            zeroGammaLevel: activeGex.zeroGammaLevel,
            regime: activeGex.regime,
            expiration: selectedDte,
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
  }, [activeGex, spyLast, vixLast, selectedDte])

  if (!gexProfile) {
    return (
      <motion.section
        className="card mt-4 opacity-50"
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
      className="card mt-4"
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

      {/* DTE selector + Analisar Fluxo button */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1 flex-wrap">
          {DTE_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => { setSelectedDte(tab.key); setFlowText(''); setFlowState('idle') }}
              className={`px-2 py-0.5 text-[10px] font-semibold rounded border transition-colors ${
                selectedDte === tab.key
                  ? 'bg-[#00ff88]/10 border-[#00ff88]/40 text-[#00ff88]'
                  : 'border-border-subtle text-text-muted hover:text-text-secondary'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          onClick={analyzeFlow}
          disabled={flowState === 'streaming' || !activeGex}
          className={`ml-2 text-[10px] font-semibold px-2.5 py-1 rounded border transition-colors whitespace-nowrap ${
            flowState === 'streaming' || !activeGex
              ? 'border-border-subtle text-text-muted cursor-not-allowed'
              : 'border-[#00ff88]/30 text-[#00ff88] hover:bg-[#00ff88]/5'
          }`}
        >
          {flowState === 'streaming' ? '⏳ Analisando...' : '⚡ Analisar Fluxo'}
        </button>
      </div>

      {/* No data for selected DTE */}
      {!activeGex && (
        <p className="text-xs text-text-secondary mb-4">Sem dados para este vencimento.</p>
      )}

      {activeGex && (
        <>
          {/* Key metrics */}
          <div className="grid grid-cols-4 gap-3 mb-4 text-center">
            <div>
              <div className="text-[10px] text-text-muted uppercase tracking-wider">GEX Total</div>
              <div className={`text-sm font-bold font-num ${regimeColor}`}>
                {activeGex.totalGEX >= 0 ? '+' : ''}{fmtM(activeGex.totalGEX)}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-text-muted uppercase tracking-wider">Flip Point</div>
              <div className="text-sm font-bold font-num text-text-primary">
                {activeGex.flipPoint ?? '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-text-muted uppercase tracking-wider">Max Gamma</div>
              <div className="text-sm font-bold font-num text-text-primary">
                {activeGex.maxGammaStrike}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-text-muted uppercase tracking-wider">Regime</div>
              <div className={`text-[10px] font-semibold ${regimeColor}`}>
                {regimeDesc}
              </div>
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

                  {/* Call bars — green */}
                  <Bar
                    dataKey="callGex"
                    name="Call GEX"
                    fill="#00ff88"
                    fillOpacity={0.75}
                    maxBarSize={18}
                    isAnimationActive={false}
                  >
                    <LabelList
                      dataKey="callGex"
                      position="top"
                      formatter={(v: number) => (v > 0.5 ? `$${v.toFixed(1)}` : '')}
                      fill="#00ff88"
                      fontSize={7}
                    />
                  </Bar>

                  {/* Put bars — red */}
                  <Bar
                    dataKey="putGex"
                    name="Put GEX"
                    fill="#ff4444"
                    fillOpacity={0.65}
                    maxBarSize={18}
                    isAnimationActive={false}
                  >
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
            Análise de Fluxo — {selectedDte}
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
