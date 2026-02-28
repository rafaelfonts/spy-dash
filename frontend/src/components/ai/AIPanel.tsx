import { motion, AnimatePresence } from 'framer-motion'
import { useAIAnalysis } from '../../hooks/useAIAnalysis'
import { AnalysisResult } from './AnalysisResult'
import { Skeleton, SkeletonText } from '../ui/Skeleton'
import { useMarketStore } from '../../store/marketStore'
import { fmtPrice, fmtPct, fmtChange } from '../../lib/formatters'

export function AIPanel() {
  const { text, state, error, cooldownSeconds, analyze, reset, structuredOutput } = useAIAnalysis()
  const spy = useMarketStore((s) => s.spy)
  const vix = useMarketStore((s) => s.vix)
  const ivRank = useMarketStore((s) => s.ivRank)

  const isLoading = state === 'loading'
  const isStreaming = state === 'streaming'
  const isDone = state === 'done'
  const isError = state === 'error'
  const isIdle = state === 'idle'
  const hasData = spy.last !== null

  return (
    <motion.section
      className="card mt-4"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut', delay: 0.25 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-display font-bold text-text-primary tracking-wide">
            Análise IA
          </h2>
          <p className="text-[11px] text-text-muted mt-0.5">
            Powered by GPT-4o — estratégias de opções em tempo real
          </p>
        </div>

        <div className="flex items-center gap-2">
          {(isDone || isError) && (
            <button
              onClick={reset}
              className="text-[11px] text-text-muted hover:text-text-secondary transition-colors px-2 py-1 rounded border border-border-subtle hover:border-border"
            >
              Limpar
            </button>
          )}

          <button
            onClick={analyze}
            disabled={isLoading || isStreaming || !hasData || cooldownSeconds > 0}
            className={`
              px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-200
              ${
                isLoading || isStreaming || cooldownSeconds > 0
                  ? 'bg-bg-elevated text-text-muted cursor-not-allowed border border-border-subtle'
                  : !hasData
                    ? 'bg-bg-elevated text-text-muted cursor-not-allowed border border-border-subtle'
                    : 'bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/30 hover:bg-[#00ff88]/20 hover:border-[#00ff88]/50 active:scale-95'
              }
            `}
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                Analisando...
              </span>
            ) : isStreaming ? (
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#00ff88] animate-pulse-dot" />
                Gerando...
              </span>
            ) : cooldownSeconds > 0 ? (
              `Aguarde ${cooldownSeconds}s...`
            ) : (
              'Analisar com IA'
            )}
          </button>
        </div>
      </div>

      {/* Market snapshot summary */}
      {hasData && (
        <div className="grid grid-cols-3 gap-3 mb-4 p-3 bg-bg-elevated rounded-lg border border-border-subtle">
          <div className="text-center">
            <div className="text-[10px] text-text-muted mb-0.5">SPY</div>
            <div className="text-xs font-num font-semibold text-text-primary">
              ${fmtPrice(spy.last)}
            </div>
            <div
              className={`text-[10px] font-num ${spy.changePct && spy.changePct >= 0 ? 'text-[#00ff88]' : 'text-red-400'}`}
            >
              {fmtPct(spy.changePct)}
            </div>
          </div>
          <div className="text-center border-x border-border-subtle">
            <div className="text-[10px] text-text-muted mb-0.5">VIX</div>
            <div className="text-xs font-num font-semibold text-text-primary">
              {fmtPrice(vix.last, 2)}
            </div>
            <div className="text-[10px] text-text-muted capitalize">
              {vix.level ?? '—'}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-text-muted mb-0.5">IV Rank</div>
            <div className="text-xs font-num font-semibold text-text-primary">
              {ivRank.value !== null ? `${ivRank.value.toFixed(0)}%` : '—'}
            </div>
            <div className="text-[10px] text-text-muted capitalize">
              {ivRank.label ?? '—'}
            </div>
          </div>
        </div>
      )}

      {/* Result area */}
      <AnimatePresence mode="wait">
        {isIdle && !text && (
          <motion.div
            key="idle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center py-8 text-center"
          >
            <div className="text-3xl mb-3 opacity-30">◈</div>
            <p className="text-sm text-text-muted">
              {hasData
                ? 'Clique em "Analisar com IA" para obter recomendações de estratégias'
                : 'Aguardando dados de mercado...'}
            </p>
          </motion.div>
        )}

        {isLoading && (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-3 py-2"
          >
            <SkeletonText lines={4} />
          </motion.div>
        )}

        {(isStreaming || isDone || (text && isError)) && (
          <motion.div
            key="result"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <AnalysisResult text={text} isStreaming={isStreaming} />

            {structuredOutput && isDone && (
              <div className="mt-4 space-y-3">
                {/* Bias + confidence + timeframe */}
                <div className="flex items-center gap-3">
                  <span className={`px-2.5 py-1 rounded text-xs font-bold tracking-wider ${
                    structuredOutput.bias === 'bullish'
                      ? 'bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/30'
                      : structuredOutput.bias === 'bearish'
                      ? 'bg-red-500/10 text-red-400 border border-red-500/30'
                      : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30'
                  }`}>
                    {structuredOutput.bias.toUpperCase()}
                  </span>
                  <div className="flex-1">
                    <div className="flex justify-between text-[10px] text-text-muted mb-1">
                      <span>Confiança</span>
                      <span>{Math.round(structuredOutput.confidence * 100)}%</span>
                    </div>
                    <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[#00ff88]/60 rounded-full transition-all duration-500"
                        style={{ width: `${structuredOutput.confidence * 100}%` }}
                      />
                    </div>
                  </div>
                  <span className="text-[10px] text-text-muted px-2 py-0.5 rounded border border-border-subtle">
                    {structuredOutput.timeframe}
                  </span>
                </div>

                {/* Key levels */}
                {(structuredOutput.key_levels.support.length > 0 || structuredOutput.key_levels.resistance.length > 0) && (
                  <div className="p-3 bg-bg-elevated rounded-lg border border-border-subtle">
                    <div className="text-[10px] text-text-muted mb-2 font-semibold tracking-wide uppercase">Níveis-chave</div>
                    <div className="flex flex-wrap gap-1.5">
                      {structuredOutput.key_levels.resistance.map((level) => (
                        <span key={`r-${level}`} className="text-[11px] font-num px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">
                          R ${level}
                        </span>
                      ))}
                      {structuredOutput.key_levels.gex_flip && (
                        <span className="text-[11px] font-num px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">
                          GEX flip ${structuredOutput.key_levels.gex_flip}
                        </span>
                      )}
                      {structuredOutput.key_levels.support.map((level) => (
                        <span key={`s-${level}`} className="text-[11px] font-num px-2 py-0.5 rounded bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/20">
                          S ${level}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Catalysts + risk factors */}
                {(structuredOutput.catalysts.length > 0 || structuredOutput.risk_factors.length > 0) && (
                  <div className="flex gap-2 flex-wrap">
                    {structuredOutput.catalysts.map((c) => (
                      <span key={c} className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                        {c}
                      </span>
                    ))}
                    {structuredOutput.risk_factors.map((r) => (
                      <span key={r} className="text-[10px] px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400 border border-orange-500/20">
                        ⚠ {r}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}

        {isError && !text && (
          <motion.div
            key="error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center gap-3 py-6"
          >
            <div className="text-red-400 text-sm font-semibold">
              Erro ao processar análise
            </div>
            <p className="text-xs text-text-muted text-center max-w-xs">{error}</p>
            <button
              onClick={analyze}
              className="text-xs text-[#00ff88] border border-[#00ff88]/30 px-3 py-1.5 rounded hover:bg-[#00ff88]/10 transition-colors"
            >
              Tentar novamente
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  )
}
