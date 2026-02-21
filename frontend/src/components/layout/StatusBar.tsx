import { useMarketStore } from '../../store/marketStore'
import type { WSState } from '../../store/marketStore'

const STATUS_MESSAGES: Record<WSState, string> = {
  CONNECTING: 'Conectando ao servidor de streaming...',
  OPEN: 'Dados ao vivo via WebSocket DXFeed',
  RECONNECTING: 'Reconectando — último dado conhecido sendo exibido',
  CLOSED: 'Desconectado do servidor de streaming',
}

export function StatusBar() {
  const wsState = useMarketStore((s) => s.connection.wsState)
  const reconnectAttempts = useMarketStore((s) => s.connection.reconnectAttempts)
  const lastUpdated = useMarketStore((s) => s.spy.lastUpdated)

  const message = STATUS_MESSAGES[wsState]
  const colorClass =
    wsState === 'OPEN'
      ? 'text-[#00ff88]/60'
      : wsState === 'CLOSED'
        ? 'text-red-400/60'
        : 'text-yellow-400/60'

  const ago =
    lastUpdated > 0
      ? `Última atualização: ${Math.round((Date.now() - lastUpdated) / 1000)}s atrás`
      : ''

  return (
    <div className="flex items-center justify-between px-4 sm:px-6 py-1.5 border-b border-border-subtle bg-bg-base">
      <span className={`text-[10px] tracking-wide ${colorClass}`}>
        {message}
        {wsState === 'RECONNECTING' && reconnectAttempts > 0 && (
          <span className="ml-1 opacity-60">(tentativa {reconnectAttempts})</span>
        )}
      </span>
      {ago && (
        <span className="text-[10px] text-text-muted hidden sm:inline">{ago}</span>
      )}
    </div>
  )
}
