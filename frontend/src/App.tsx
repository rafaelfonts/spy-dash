import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuth } from './hooks/useAuth'
import { useMarketStream } from './hooks/useMarketStream'
import { LoginPage } from './components/auth/LoginPage'
import { Header } from './components/layout/Header'
import { StatusBar } from './components/layout/StatusBar'
import { SPYCard } from './components/cards/SPYCard'
import { IVRankCard } from './components/cards/IVRankCard'
import { VIXCard } from './components/cards/VIXCard'
import { AIPanel } from './components/ai/AIPanel'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 2 },
  },
})

function Dashboard({ onLogout }: { onLogout: () => void }) {
  useMarketStream()

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
        <AIPanel />
      </main>

      <footer className="text-center py-4 text-[10px] text-text-muted border-t border-border-subtle mt-8">
        SPY DASH — Dados via Tastytrade DXFeed · IA via GPT-4o
      </footer>
    </div>
  )
}

function AppContent() {
  const auth = useAuth()

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
