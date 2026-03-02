import { useEffect, useRef } from 'react'
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
  const briefing = useMarketStore((s) => s.preMarketBriefing)
  const setPreMarketBriefing = useMarketStore((s) => s.setPreMarketBriefing)
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-dismiss at 10:00 ET for pre-market briefing
  useEffect(() => {
    if (!briefing || briefing.type !== 'pre-market') return

    const ms = getMsUntilCollapse()
    if (ms === 0) {
      // Already past 10:00 ET — hide immediately
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

  // Don't render if no briefing or already expired
  if (!briefing) return null
  if (new Date() >= new Date(briefing.expiresAt)) return null

  const isPreMarket = briefing.type === 'pre-market'
  const emoji = isPreMarket ? '🌅' : '🏁'
  const title = isPreMarket ? 'Pre-Market Briefing' : 'Resumo do Dia'

  return (
    <div className="relative rounded-lg border border-blue-700/30 bg-gradient-to-br from-blue-950/80 to-purple-950/80 p-4 mb-4">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base">{emoji}</span>
            <span className="text-sm font-semibold text-blue-200">{title}</span>
            <span className="text-xs text-blue-400/60 font-medium uppercase tracking-wide">SPY</span>
          </div>
          <p className="text-xs text-blue-400/70 mt-0.5">
            Gerado às {formatGeneratedAt(briefing.generatedAt)}
          </p>
        </div>

        {/* Dismiss button */}
        <button
          onClick={() => setPreMarketBriefing(null)}
          className="text-blue-400/50 hover:text-blue-300 transition-colors text-lg leading-none ml-4 flex-shrink-0"
          aria-label="Dispensar briefing"
        >
          ×
        </button>
      </div>

      {/* Markdown content */}
      <div className="prose prose-invert max-w-none text-sm leading-relaxed">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => (
              <h1 className="text-base font-display font-bold text-blue-100 mb-2 mt-4 first:mt-0">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="text-sm font-display font-semibold text-blue-200 mb-1.5 mt-3 first:mt-0">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="text-sm font-semibold text-blue-300 mb-1 mt-2">{children}</h3>
            ),
            p: ({ children }) => (
              <p className="text-blue-100/80 mb-2 last:mb-0">{children}</p>
            ),
            ul: ({ children }) => (
              <ul className="space-y-1 mb-2 pl-4">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="space-y-1 mb-2 pl-4 list-decimal">{children}</ol>
            ),
            li: ({ children }) => (
              <li className="text-blue-100/80 marker:text-blue-400">{children}</li>
            ),
            strong: ({ children }) => (
              <strong className="text-blue-100 font-semibold">{children}</strong>
            ),
            em: ({ children }) => (
              <em className="text-blue-300 not-italic">{children}</em>
            ),
            code: ({ children, className }) => {
              const isBlock = className?.includes('language-')
              return isBlock ? (
                <code className="block bg-blue-950/60 border border-blue-800/40 rounded p-3 text-xs text-blue-100 font-mono overflow-x-auto my-2">
                  {children}
                </code>
              ) : (
                <code className="bg-blue-950/60 px-1 py-0.5 rounded text-xs text-blue-300 font-mono">
                  {children}
                </code>
              )
            },
            blockquote: ({ children }) => (
              <blockquote className="border-l-2 border-blue-500/40 pl-3 my-2 text-blue-100/70">
                {children}
              </blockquote>
            ),
            hr: () => <hr className="border-blue-700/30 my-3" />,
          }}
        >
          {briefing.markdown}
        </ReactMarkdown>
      </div>
    </div>
  )
}
