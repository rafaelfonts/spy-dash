import { useMarketStore } from '../../store/marketStore'
import { ConnectionDot } from '../ui/ConnectionDot'
import { useMarketOpen } from '../../hooks/useMarketOpen'
import { fmtPrice, fmtPct } from '../../lib/formatters'

interface HeaderProps {
  onLogout: () => void
}

export function Header({ onLogout }: HeaderProps) {
  const connection = useMarketStore((s) => s.connection)
  const spy = useMarketStore((s) => s.spy)
  const isMarketOpen = useMarketOpen()

  const priceTitle =
    spy.last !== null
      ? `SPY $${fmtPrice(spy.last)} (${fmtPct(spy.changePct)}) — SPY DASH`
      : 'SPY DASH'

  if (typeof document !== 'undefined') {
    document.title = priceTitle
  }

  return (
    <header className="sticky top-0 z-50 border-b border-border-subtle bg-bg-base/90 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-[#00ff88]/10 border border-[#00ff88]/20 flex items-center justify-center">
            <span className="text-[#00ff88] text-xs font-extrabold font-display">S</span>
          </div>
          <span className="font-display text-base tracking-wide">
            <span className="font-extrabold text-text-primary">SPY </span>
            <span className="font-extrabold text-[#00ff88]">DASH</span>
          </span>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-4">
          {/* Market status */}
          <span
            className={`hidden sm:inline text-[10px] font-semibold tracking-widest uppercase ${
              isMarketOpen ? 'text-[#00ff88]' : 'text-text-muted'
            }`}
          >
            NYSE {isMarketOpen ? '● ABERTO' : '● FECHADO'}
          </span>

          {/* Connection status */}
          <ConnectionDot wsState={connection.wsState} />

          {/* Logout */}
          <button
            onClick={onLogout}
            title="Sair"
            className="text-text-muted hover:text-text-secondary transition-colors p-1 rounded"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  )
}
