import { motion } from 'framer-motion'
import { useMarketStore } from '../../store/marketStore'
import { EarningsCalendar } from './EarningsCalendar'
import { MacroData } from './MacroData'
import { MacroCalendar } from './MacroCalendar'
import { NewsHeadlines } from './NewsHeadlines'
import { FearGreedGauge } from './FearGreedGauge'

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold tracking-widest text-text-muted uppercase mb-2 flex items-center gap-1.5">
      <span className="w-3 h-px bg-border" />
      {children}
      <span className="flex-1 h-px bg-border-subtle" />
    </div>
  )
}

export function NewsFeedPanel() {
  const newsFeed = useMarketStore((s) => s.newsFeed)

  const hasEarnings = newsFeed.earnings.length > 0
  const hasMacro = newsFeed.macro.length > 0
  const hasBls = newsFeed.bls.length > 0
  const hasMacroEvents = newsFeed.macroEvents.length > 0
  const hasHeadlines = newsFeed.headlines.length > 0
  const isLoading = newsFeed.lastUpdated === 0
  const hasStale = Object.values(newsFeed.staleFlags).some(Boolean)

  const lastUpdatedStr = newsFeed.lastUpdated
    ? new Date(newsFeed.lastUpdated).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

  return (
    <motion.section
      className="card mt-4"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut', delay: 0.35 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-sm font-display font-bold text-text-primary tracking-wide">
            Feed de Mercado
          </h2>
          <p className="text-[11px] text-text-muted mt-0.5">
            Earnings · Macro FRED/BLS · Eventos · Headlines · Sentimento
          </p>
        </div>

        {lastUpdatedStr && (
          <span className="text-[10px] text-text-muted tabular-nums">
            atualizado {lastUpdatedStr}
          </span>
        )}
      </div>

      {/* Stale data warning */}
      {hasStale && (
        <div className="mb-4 px-3 py-2 rounded border border-yellow-500/30 bg-yellow-500/10 text-[11px] text-yellow-400 flex items-center gap-2">
          <span>⚠</span>
          <span>Alguns dados podem estar desatualizados — última busca falhou ou retornou formato inválido</span>
        </div>
      )}

      {/* Row 1: Earnings + Macro FRED/BLS + Sentimento */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
        <div>
          <SectionTitle>Earnings Calendar</SectionTitle>
          <EarningsCalendar
            earnings={newsFeed.earnings}
            loading={isLoading && !hasEarnings}
          />
        </div>

        <div className="md:border-l md:border-border-subtle md:pl-4">
          <SectionTitle>Dados Macro — FRED / BLS</SectionTitle>
          <MacroData
            macro={newsFeed.macro}
            bls={newsFeed.bls}
            loading={isLoading && !hasMacro && !hasBls}
          />
        </div>

        <div className="md:border-l md:border-border-subtle md:pl-4">
          <SectionTitle>Sentimento do Mercado</SectionTitle>
          <FearGreedGauge fearGreed={newsFeed.fearGreed} />
        </div>
      </div>

      <div className="border-t border-border-subtle mb-5" />

      {/* Row 2: Macro Events (1 col) + Headlines (2 cols) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <SectionTitle>Eventos Macro — Próximas 48h</SectionTitle>
          <MacroCalendar
            events={newsFeed.macroEvents}
            loading={isLoading && !hasMacroEvents}
          />
        </div>

        <div className="md:border-l md:border-border-subtle md:pl-4 md:col-span-2">
          <SectionTitle>Headlines</SectionTitle>
          <NewsHeadlines
            headlines={newsFeed.headlines}
            loading={isLoading && !hasHeadlines}
          />
        </div>
      </div>
    </motion.section>
  )
}
