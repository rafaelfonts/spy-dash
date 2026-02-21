import type { WSState } from '../../store/marketStore'

interface ConnectionDotProps {
  wsState: WSState
  className?: string
}

const STATE_CONFIG: Record<WSState, { color: string; label: string; pulse: boolean }> = {
  CONNECTING: {
    color: 'bg-yellow-400',
    label: 'CONECTANDO',
    pulse: true,
  },
  OPEN: {
    color: 'bg-[#00ff88]',
    label: 'AO VIVO',
    pulse: true,
  },
  RECONNECTING: {
    color: 'bg-yellow-400',
    label: 'RECONECTANDO',
    pulse: false,
  },
  CLOSED: {
    color: 'bg-red-500',
    label: 'DESCONECTADO',
    pulse: false,
  },
}

export function ConnectionDot({ wsState, className = '' }: ConnectionDotProps) {
  const config = STATE_CONFIG[wsState]

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-widest uppercase ${className}`}
    >
      <span
        className={`
          inline-block w-2 h-2 rounded-full ${config.color}
          ${config.pulse ? 'animate-pulse-dot' : 'animate-blink'}
        `}
      />
      <span
        className={
          wsState === 'OPEN'
            ? 'text-[#00ff88]'
            : wsState === 'CLOSED'
              ? 'text-red-400'
              : 'text-yellow-400'
        }
      >
        {config.label}
      </span>
    </span>
  )
}
