import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuth } from './hooks/useAuth'
import { useMarketStream } from './hooks/useMarketStream'
import { useOptionChain } from './hooks/useOptionChain'
import { LoginPage } from './components/auth/LoginPage'
import { Header } from './components/layout/Header'
import { TabNav, type TabId } from './components/layout/TabNav'
import { BottomNav } from './components/layout/BottomNav'
import { TickerStrip } from './components/layout/TickerStrip'
import { AIPanel } from './components/ai/AIPanel'
import { RegimeDashboard } from './components/ai/RegimeDashboard'
import { PreMarketBriefing } from './components/ai/PreMarketBriefing'
import { LastScheduledSignal } from './components/ai/LastScheduledSignal'
import { SignalPerformanceCard } from './components/ai/SignalPerformanceCard'
import { OptionChainPanel } from './components/options/OptionChainPanel'
import { OptionScreenerPanel } from './components/options/OptionScreenerPanel'
import { GEXPanel } from './components/options/GEXPanel'
import { PortfolioPanel } from './components/portfolio/PortfolioPanel'
import { TechnicalIndicatorsCard } from './components/cards/TechnicalIndicatorsCard'
import { VolSurfaceChart } from './components/charts/VolSurfaceChart'
import { NewsFeedPanel } from './components/news/NewsFeedPanel'
import { AlertOverlay } from './components/ui/AlertOverlay'
import { EquityTab } from './components/equity/EquityTab'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 2 },
  },
})

function Dashboard({ onLogout }: { onLogout: () => void }) {
  useMarketStream()
  useOptionChain()
  const [activeTab, setActiveTab] = useState<TabId>('dashboard')

  return (
    <div className="min-h-screen bg-bg-base">
      {/* Sticky header group */}
      <div className="sticky top-0 z-50">
        <Header onLogout={onLogout} />
        <TickerStrip />
        <TabNav active={activeTab} onChange={setActiveTab} />
      </div>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-4 pb-20 md:pb-6">
        {activeTab === 'dashboard' && (
          <>
            <PreMarketBriefing />
            <LastScheduledSignal />
            <SignalPerformanceCard />
            <RegimeDashboard />
            <AIPanel />
            <OptionScreenerPanel />
          </>
        )}

        {activeTab === 'mercado' && (
          <>
            <GEXPanel />
            <VolSurfaceChart />
            <TechnicalIndicatorsCard />
            <OptionChainPanel />
          </>
        )}

        {activeTab === 'macro' && (
          <NewsFeedPanel />
        )}

        {activeTab === 'portfolio' && (
          <PortfolioPanel />
        )}

        {activeTab === 'acoes' && <EquityTab />}
      </main>

      <footer className="text-center py-4 text-[10px] text-text-muted border-t border-border-subtle mt-8">
        SPY DASH — Dados via Tastytrade DXFeed · IA via Claude Sonnet 4.6
      </footer>

      <AlertOverlay />
      <BottomNav active={activeTab} onChange={setActiveTab} />
    </div>
  )
}

function AppContent() {
  const auth = useAuth()

  // Evita flash da LoginPage enquanto Supabase verifica sessão existente
  if (auth.isLoading && !auth.error) {
    return (
      <div className="min-h-screen bg-bg-base flex items-center justify-center">
        <span className="w-6 h-6 rounded-full border-2 border-[#00ff88] border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!auth.isAuthenticated) {
    return <LoginPage auth={auth} />
  }

  return <Dashboard onLogout={auth.logout} />
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  )
}
