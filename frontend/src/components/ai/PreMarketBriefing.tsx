import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useMarketStore } from '../../store/marketStore'

// Auto-collapse delay after market open (10:00 ET = 30min after 9:30 open)
const COLLAPSE_HOUR_ET = 10
const COLLAPSE_MIN_ET = 0

function getETNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
}

function getMsUntilCollapse(): number {
  const et = getETNow()
  const collapse = new Date(et)
  collapse.setHours(COLLAPSE_HOUR_ET, COLLAPSE_MIN_ET, 0, 0)
  const ms = collapse.getTime() - et.getTime()
  // If already past collapse time, return 0 (component won't render anyway)
  return Math.max(0, ms)
}

function formatGeneratedAt(iso: string): string {
  try {
    const et = new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York' }))
    return et.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + ' ET'
  } catch {
    return iso
  }
}

export function PreMarketBriefing() {
  const [isExpanded, setIsExpanded] = useState(false)
  const briefing = useMarketStore((s) => s.preMarketBriefing)
  const setPreMarketBriefing = useMarketStore((s) => s.setPreMarketBriefing)
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-dismiss at 10:00 ET for pre-market briefing
  useEffect(() => {
    if (!briefing || briefing.type !== 'pre-market') return

    const ms = getMsUntilCollapse()
    if (ms === 0) {
      setPreMarketBriefing(null)
      return
    }

    collapseTimerRef.current = setTimeout(() => {
      setPreMarketBriefing(null)
    }, ms)

    return () => {
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current)
    }
  }, [briefing, setPreMarketBriefing])

  if (!briefing) return null
  if (new Date() >= new Date(briefing.expiresAt)) return null

  const isPreMarket = briefing.type === 'pre-market'
  const emoji = isPreMarket ? '🌅' : '🏁'
  const title = isPreMarket ? 'Pre-Market Briefing' : 'Resumo do Dia'

  // Plain-text preview: first non-heading paragraph line
  const preview = briefing.markdown
    .replace(/^#+\s.*/gm, '')
    .replace(/[*_`]/g, '')
    .trim()
    .split('\n')
    .filter(Boolean)[0]
    ?.slice(0, 140) ?? ''

  return (
    <div className="relative rounded-lg border border-[#00ff88]/20 bg-gradient-to-br from-bg-card to-[#00ff88]/[0.08] mb-4 overflow-hidden">

      {/* Dismiss button — absolute to avoid nesting inside clickable header */}
      <button
        onClick={() => setPreMarketBriefing(null)}
        className="absolute top-3 right-3 text-text-muted hover:text-text-secondary transition-colors text-lg leading-none z-10"
        aria-label="Dispensar briefing"
      >
        ×
      </button>

      {/* Header — clicável para expandir/recolher */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-controls="briefing-content"
        onClick={() => setIsExpanded((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsExpanded((v) => !v) } }}
        className="flex items-start justify-between p-4 pr-12 cursor-pointer select-none"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-base">{emoji}</span>
            <span className="text-sm font-semibold text-accent-green">{title}</span>
            <span className="text-xs text-text-muted font-medium uppercase tracking-wide">SPY</span>
          </div>
          <p className="text-xs text-text-muted mt-0.5">
            Gerado às {formatGeneratedAt(briefing.generatedAt)}
          </p>

          {/* Preview — visível apenas quando colapsado */}
          {!isExpanded && preview && (
            <p className="text-xs text-text-secondary mt-1.5 truncate pr-2">
              {preview}
            </p>
          )}
        </div>

        {/* Chevron */}
        <svg
          className={`w-4 h-4 text-text-muted transition-transform duration-200 mt-0.5 flex-shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* Conteúdo expandível */}
      <div
        id="briefing-content"
        className={`overflow-hidden transition-[max-height] duration-300 ease-in-out ${isExpanded ? 'max-h-[1200px]' : 'max-h-0'}`}
      >
        <div className="px-4 pb-4 border-t border-[#00ff88]/10 pt-3">
          <div className="prose prose-invert max-w-none text-sm leading-relaxed">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => (
                  <h1 className="text-base font-display font-bold text-text-primary mb-2 mt-4 first:mt-0">
                    {children}
                  </h1>
                ),
                h2: ({ children }) => (
                  <h2 className="text-sm font-display font-semibold text-text-primary mb-1.5 mt-3 first:mt-0">
                    {children}
                  </h2>
                ),
                h3: ({ children }) => (
                  <h3 className="text-sm font-semibold text-text-secondary mb-1 mt-2">{children}</h3>
                ),
                p: ({ children }) => (
                  <p className="text-text-primary/80 mb-2 last:mb-0">{children}</p>
                ),
                ul: ({ children }) => (
                  <ul className="space-y-1 mb-2 pl-4">{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol className="space-y-1 mb-2 pl-4 list-decimal">{children}</ol>
                ),
                li: ({ children }) => (
                  <li className="text-text-primary/80 marker:text-text-muted">{children}</li>
                ),
                strong: ({ children }) => (
                  <strong className="text-text-primary font-semibold">{children}</strong>
                ),
                em: ({ children }) => (
                  <em className="text-text-secondary not-italic">{children}</em>
                ),
                code: ({ children, className }) => {
                  const isBlock = className?.includes('language-')
                  return isBlock ? (
                    <code className="block bg-bg-elevated border border-border-subtle rounded p-3 text-xs text-text-primary font-mono overflow-x-auto my-2">
                      {children}
                    </code>
                  ) : (
                    <code className="bg-bg-elevated px-1 py-0.5 rounded text-xs text-text-secondary font-mono">
                      {children}
                    </code>
                  )
                },
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-[#00ff88]/30 pl-3 my-2 text-text-primary/70">
                    {children}
                  </blockquote>
                ),
                hr: () => <hr className="border-border-subtle my-3" />,
              }}
            >
              {briefing.markdown}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  )
}
