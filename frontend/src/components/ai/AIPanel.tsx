import { motion, AnimatePresence } from 'framer-motion'
import { useAIAnalysis } from '../../hooks/useAIAnalysis'
import type { ChatMessage } from '../../hooks/useAIAnalysis'
import { AnalysisResult } from './AnalysisResult'
import { Skeleton, SkeletonText } from '../ui/Skeleton'
import { useMarketStore } from '../../store/marketStore'
import { fmtPrice, fmtPct } from '../../lib/formatters'

const MAX_PANEL_HEIGHT = 520
const MAX_PANEL_HEIGHT_MOBILE = '60vh'

function BiasBadge({ bias }: { bias: 'bullish' | 'bearish' | 'neutral' }) {
  const config =
    bias === 'bullish'
      ? { label: 'BULLISH', className: 'bg-[#00ff88]/10 text-[#00ff88] border-[#00ff88]/30' }
      : bias === 'bearish'
        ? { label: 'BEARISH', className: 'bg-red-500/10 text-red-400 border-red-500/30' }
        : { label: 'NEUTRAL', className: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30' }
  return (
    <span className={`px-2.5 py-1 rounded text-xs font-bold tracking-wider border ${config.className}`}>
      {config.label}
    </span>
  )
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-[11px] ${
          isUser
            ? 'bg-[#00ff88]/10 text-text-primary border border-[#00ff88]/20'
            : 'bg-bg-elevated text-text-secondary border border-border-subtle'
        }`}
      >
        {message.content}
      </div>
    </div>
  )
}

export function AIPanel() {
  const {
    text,
    state,
    error,
    cooldownSeconds,
    analyze,
    reset,
    structuredOutput,
    chatHistory,
    chatInput,
    setChatInput,
    isChatLoading,
    isExpanded,
    setExpanded,
    sendChatMessage,
  } = useAIAnalysis()
  const spy = useMarketStore((s) => s.spy)
  const vix = useMarketStore((s) => s.vix)
  const ivRank = useMarketStore((s) => s.ivRank)

  const isLoading = state === 'loading'
  const isStreaming = state === 'streaming'
  const isDone = state === 'done'
  const isError = state === 'error'
  const isIdle = state === 'idle'
  const hasData = spy.last !== null
  const hasAnalysis = isStreaming || isDone || isError

  const formatTimestamp = () => {
    return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <motion.section
      className="card mt-4"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut', delay: 0.25 }}
    >
      {/* Collapsed: trigger or mini-preview */}
      {!isExpanded && (
        <>
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
                <div className="text-[10px] text-text-muted capitalize">{vix.level ?? '—'}</div>
              </div>
              <div className="text-center">
                <div className="text-[10px] text-text-muted mb-0.5">IV Rank</div>
                <div className="text-xs font-num font-semibold text-text-primary">
                  {ivRank.value !== null ? `${ivRank.value.toFixed(0)}%` : '—'}
                </div>
                <div className="text-[10px] text-text-muted capitalize">{ivRank.label ?? '—'}</div>
              </div>
            </div>
          )}

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

            {hasAnalysis && isDone && structuredOutput && (
              <motion.div
                key="preview"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col gap-2"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <BiasBadge bias={structuredOutput.bias} />
                  <span className="text-[11px] text-text-muted">
                    {structuredOutput.suggested_strategy?.name ?? '—'}
                  </span>
                </div>
                <button
                  onClick={() => setExpanded(true)}
                  className="text-xs text-[#00ff88] border border-[#00ff88]/30 px-3 py-1.5 rounded hover:bg-[#00ff88]/10 transition-colors w-fit"
                >
                  Ver análise completa
                </button>
              </motion.div>
            )}

            {hasAnalysis && (isStreaming || (isDone && !structuredOutput)) && (
              <motion.div key="result-inline" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <AnalysisResult text={text} isStreaming={isStreaming} />
                {isDone && (
                  <button
                    onClick={() => setExpanded(true)}
                    className="mt-2 text-xs text-[#00ff88] border border-[#00ff88]/30 px-3 py-1.5 rounded hover:bg-[#00ff88]/10"
                  >
                    Ver análise completa
                  </button>
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
                <div className="text-red-400 text-sm font-semibold">Erro ao processar análise</div>
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
        </>
      )}

      {/* Expanded panel */}
      <AnimatePresence>
        {isExpanded && hasAnalysis && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="border border-border-subtle rounded-lg bg-bg-elevated/50 flex flex-col">
              {/* Fixed header */}
              <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
                <div className="flex items-center gap-2">
                  {structuredOutput && (
                    <BiasBadge bias={structuredOutput.bias} />
                  )}
                  <span className="text-[11px] text-text-muted">{formatTimestamp()}</span>
                </div>
                <button
                  onClick={() => setExpanded(false)}
                  className="text-text-muted hover:text-text-primary p-1 rounded transition-colors"
                  aria-label="Fechar painel"
                >
                  ✕
                </button>
              </div>

              {/* Scrollable body — max 520px (60vh mobile) */}
              <div
                className="px-3 py-3 overflow-y-auto overflow-x-hidden shrink min-h-0"
                style={{
                  maxHeight: `min(${MAX_PANEL_HEIGHT}px, ${MAX_PANEL_HEIGHT_MOBILE})`,
                }}
              >
                <AnalysisResult text={text} isStreaming={isStreaming} />
                {structuredOutput && isDone && (
                  <div className="mt-4 space-y-3">
                    <div className="flex items-center gap-3">
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
                    {(structuredOutput.key_levels.support.length > 0 ||
                      structuredOutput.key_levels.resistance.length > 0) && (
                      <div className="p-3 bg-bg-elevated rounded-lg border border-border-subtle">
                        <div className="text-[10px] text-text-muted mb-2 font-semibold uppercase">
                          Níveis-chave
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {structuredOutput.key_levels.resistance.map((level) => (
                            <span
                              key={`r-${level}`}
                              className="text-[11px] font-num px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20"
                            >
                              R ${level}
                            </span>
                          ))}
                          {structuredOutput.key_levels.gex_flip && (
                            <span className="text-[11px] font-num px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">
                              GEX flip ${structuredOutput.key_levels.gex_flip}
                            </span>
                          )}
                          {structuredOutput.key_levels.support.map((level) => (
                            <span
                              key={`s-${level}`}
                              className="text-[11px] font-num px-2 py-0.5 rounded bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/20"
                            >
                              S ${level}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {structuredOutput.suggested_strategy && (
                      <div className="p-3 bg-bg-elevated rounded-lg border border-border-subtle space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] text-text-muted font-semibold uppercase">
                            Estratégia
                          </span>
                          <span className="text-[11px] px-2 py-0.5 rounded bg-white/[0.04] border border-border-subtle font-semibold">
                            {structuredOutput.suggested_strategy.name}
                          </span>
                          {structuredOutput.recommended_dte != null && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                              {structuredOutput.recommended_dte}DTE
                            </span>
                          )}
                          {structuredOutput.pop_estimate != null && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/20">
                              PoP ~{Math.round(structuredOutput.pop_estimate * 100)}%
                            </span>
                          )}
                        </div>
                        <div className="flex gap-3 flex-wrap pt-1 border-t border-border-subtle text-[10px]">
                          <span className="font-num text-red-400">
                            Risco ${structuredOutput.suggested_strategy.max_risk.toFixed(2)}
                          </span>
                          {structuredOutput.expected_credit != null && (
                            <span className="font-num text-[#00ff88]">
                              Crédito ${structuredOutput.expected_credit.toFixed(2)}
                            </span>
                          )}
                          {structuredOutput.theta_per_day != null && (
                            <span className="font-num text-purple-400">
                              θ/dia ${structuredOutput.theta_per_day.toFixed(2)}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Fixed footer: chat */}
              <div className="px-3 py-2 border-t border-border-subtle shrink-0 space-y-2">
                {chatHistory.length > 0 && (
                  <div
                    className="space-y-1.5 overflow-y-auto"
                    style={{ maxHeight: 120 }}
                  >
                    {chatHistory.slice(-4).map((msg, i) => (
                      <ChatBubble key={`${msg.timestamp}-${i}`} message={msg} />
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendChatMessage()}
                    placeholder="Pergunte sobre a análise... (ex: qual o risco se SPY cair 2%?)"
                    disabled={isChatLoading || isStreaming}
                    className="flex-1 min-w-0 px-2.5 py-1.5 rounded text-xs bg-bg-elevated border border-border-subtle text-text-primary placeholder:text-text-muted focus:border-[#00ff88]/50 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={sendChatMessage}
                    disabled={isChatLoading || !chatInput.trim() || isStreaming}
                    className="px-3 py-1.5 rounded text-xs font-semibold bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/30 hover:bg-[#00ff88]/20 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  >
                    {isChatLoading ? (
                      <span className="w-3 h-3 inline-block rounded-full border-2 border-current border-t-transparent animate-spin" />
                    ) : (
                      '↑'
                    )}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  )
}
