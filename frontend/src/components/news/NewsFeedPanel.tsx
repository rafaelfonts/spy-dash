import { useState } from 'react'
import { motion } from 'framer-motion'
import { useMarketStore } from '../../store/marketStore'
import { MacroData } from './MacroData'
import { MacroCalendar } from './MacroCalendar'
import { NewsHeadlines } from './NewsHeadlines'
import { FearGreedGauge } from './FearGreedGauge'
import { PutCallRatioCard } from './PutCallRatioCard'

type MobileTab = 'macro' | 'sentimento' | 'eventos' | 'headlines'

const MOBILE_TABS: { id: MobileTab; label: string }[] = [
  { id: 'macro', label: 'Macro' },
  { id: 'sentimento', label: 'Sentimento' },
  { id: 'eventos', label: 'Eventos' },
  { id: 'headlines', label: 'Headlines' },
]

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
  const [activeTab, setActiveTab] = useState<MobileTab>('macro')

  const hasMacro = newsFeed.macro.length > 0
  const hasBls = newsFeed.bls.length > 0
  const hasMacroEvents = newsFeed.macroEvents.length > 0
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
      className="card"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut', delay: 0.35 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-display font-bold text-text-primary tracking-wide">
            Feed de Mercado
          </h2>
          <p className="text-[11px] text-text-muted mt-0.5">
            Macro FRED/BLS · Eventos · Headlines · Sentimento
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

      {/* ── MOBILE: tabs de navegação ── */}
      <div className="md:hidden">
        {/* Tab bar */}
        <div className="flex border-b border-border-subtle mb-4 -mx-4 px-4 overflow-x-auto">
          {MOBILE_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap transition-colors shrink-0 ${
                activeTab === tab.id
                  ? 'text-[#00ff88] border-b-2 border-[#00ff88] -mb-px'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === 'macro' && (
          <div>
            <SectionTitle>Dados Macro — FRED / BLS</SectionTitle>
            <MacroData
              macro={newsFeed.macro}
              bls={newsFeed.bls}
              loading={isLoading && !hasMacro && !hasBls}
            />
          </div>
        )}
        {activeTab === 'sentimento' && (
          <div>
            <SectionTitle>Sentimento do Mercado</SectionTitle>
            <FearGreedGauge />
            <div className="mt-5 border-t border-border-subtle pt-4">
              <SectionTitle>Put/Call Ratio</SectionTitle>
              <PutCallRatioCard />
            </div>
          </div>
        )}
        {activeTab === 'eventos' && (
          <div>
            <SectionTitle>Eventos Macro — Próximas 48h</SectionTitle>
            <MacroCalendar
              events={newsFeed.macroEvents}
              loading={isLoading && !hasMacroEvents}
            />
          </div>
        )}
        {activeTab === 'headlines' && (
          <div>
            <SectionTitle>Headlines</SectionTitle>
            <NewsHeadlines />
          </div>
        )}
      </div>

      {/* ── DESKTOP: grid layout completo ── */}
      <div className="hidden md:block">
        {/* Row 1: Macro FRED/BLS + Sentimento + P/C Ratio */}
        <div className="grid grid-cols-3 gap-4 mb-5">
          <div>
            <SectionTitle>Dados Macro — FRED / BLS</SectionTitle>
            <MacroData
              macro={newsFeed.macro}
              bls={newsFeed.bls}
              loading={isLoading && !hasMacro && !hasBls}
            />
          </div>

          <div className="border-l border-border-subtle pl-4">
            <SectionTitle>Sentimento do Mercado</SectionTitle>
            <FearGreedGauge />
          </div>

          <div className="border-l border-border-subtle pl-4">
            <SectionTitle>Put/Call Ratio</SectionTitle>
            <PutCallRatioCard />
          </div>
        </div>

        <div className="border-t border-border-subtle mb-5" />

        {/* Row 2: Macro Events (conditional) + Headlines */}
        <div className={`grid gap-4 ${hasMacroEvents ? 'grid-cols-3' : 'grid-cols-1'}`}>
          {hasMacroEvents && (
            <div className="col-span-1">
              <SectionTitle>Eventos Macro — Próximas 48h</SectionTitle>
              <MacroCalendar events={newsFeed.macroEvents} loading={false} />
            </div>
          )}
          <div className={hasMacroEvents ? 'col-span-2 border-l border-border-subtle pl-4' : 'col-span-1'}>
            <SectionTitle>Headlines</SectionTitle>
            <NewsHeadlines />
          </div>
        </div>
      </div>
    </motion.section>
  )
}
