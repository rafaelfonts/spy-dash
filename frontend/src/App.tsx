import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuth } from './hooks/useAuth'
import { useMarketStream } from './hooks/useMarketStream'
import { useOptionChain } from './hooks/useOptionChain'
import { LoginPage } from './components/auth/LoginPage'
import { Header } from './components/layout/Header'
import { StatusBar } from './components/layout/StatusBar'
import { SPYCard } from './components/cards/SPYCard'
import { IVRankCard } from './components/cards/IVRankCard'
import { VIXCard } from './components/cards/VIXCard'
import { AIPanel } from './components/ai/AIPanel'
import { RegimeDashboard } from './components/ai/RegimeDashboard'
import { PreMarketBriefing } from './components/ai/PreMarketBriefing'
import { LastScheduledSignal } from './components/ai/LastScheduledSignal'
import { OptionChainPanel } from './components/options/OptionChainPanel'
import { GEXPanel } from './components/options/GEXPanel'
import { PortfolioPanel } from './components/portfolio/PortfolioPanel'
import { TechnicalIndicatorsCard } from './components/cards/TechnicalIndicatorsCard'
import { VolSurfaceChart } from './components/charts/VolSurfaceChart'
import { NewsFeedPanel } from './components/news/NewsFeedPanel'
import { AlertOverlay } from './components/ui/AlertOverlay'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 2 },
  },
})

function Dashboard({ onLogout }: { onLogout: () => void }) {
  useMarketStream()
  useOptionChain()

  return (
    <div className="min-h-screen bg-bg-base">
      <Header onLogout={onLogout} />
      <StatusBar />

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-2">
          <SPYCard />
          <IVRankCard />
          <VIXCard />
        </div>
        <PreMarketBriefing />
        <LastScheduledSignal />
        <PortfolioPanel />
        <AIPanel />
        <RegimeDashboard />
        <GEXPanel />
        <VolSurfaceChart />
        <TechnicalIndicatorsCard />
        <OptionChainPanel />
        <NewsFeedPanel />
      </main>

      <footer className="text-center py-4 text-[10px] text-text-muted border-t border-border-subtle mt-8">
        SPY DASH — Dados via Tastytrade DXFeed · IA via Claude Sonnet 4.6
      </footer>

      <AlertOverlay />
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
