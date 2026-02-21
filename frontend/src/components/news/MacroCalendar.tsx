import type { MacroEvent } from '../../store/marketStore'
import { Skeleton } from '../ui/Skeleton'

interface Props {
  events: MacroEvent[]
  loading: boolean
}

function impactBadge(impact: 'high' | 'medium' | 'low') {
  if (impact === 'high')
    return (
      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide bg-red-500/15 text-red-400 border border-red-500/30">
        ALTO
      </span>
    )
  return (
    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide bg-[#ffcc00]/10 text-[#ffcc00] border border-[#ffcc00]/30">
      MÉD
    </span>
  )
}

function formatTime(timeStr: string | null): string {
  if (!timeStr) return '—'
  // Finnhub returns 'YYYY-MM-DD HH:MM:SS' UTC
  const d = new Date(timeStr.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return timeStr.slice(5, 10) // fallback: MM-DD

  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()

  const time = d.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/New_York',
  })

  if (isToday) return `Hoje ${time}`

  const date = d.toLocaleDateString('pt-BR', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  })
  return `${date} ${time}`
}

function formatVal(val: number | null, unit: string | null): string {
  if (val === null) return '—'
  const u = unit ?? ''
  if (u === '%' || u.toLowerCase().includes('percent')) return `${val.toFixed(1)}%`
  if (Math.abs(val) >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`
  if (Math.abs(val) >= 1_000) return `${(val / 1_000).toFixed(0)}K`
  return val.toFixed(1)
}

export function MacroCalendar({ events, loading }: Props) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <p className="text-[11px] text-text-muted text-center py-4">
        Sem eventos macro de alto impacto nos próximos dias
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      {events.map((ev, idx) => (
        <div
          key={idx}
          className="p-2 rounded bg-bg-base/50 border border-border-subtle hover:border-border transition-colors"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                {impactBadge(ev.impact)}
                <span className="text-[10px] text-text-muted">{formatTime(ev.time)} ET</span>
              </div>
              <p className="text-xs text-text-primary font-medium leading-tight truncate">
                {ev.event}
              </p>
            </div>
          </div>

          {/* Consensus / Previous */}
          {(ev.estimate !== null || ev.prev !== null || ev.actual !== null) && (
            <div className="flex gap-3 mt-1.5 text-[10px]">
              {ev.actual !== null && (
                <span>
                  <span className="text-text-muted">Real: </span>
                  <span className="text-[#00ff88] font-num font-semibold">
                    {formatVal(ev.actual, ev.unit)}
                  </span>
                </span>
              )}
              {ev.estimate !== null && ev.actual === null && (
                <span>
                  <span className="text-text-muted">Consenso: </span>
                  <span className="text-text-secondary font-num">{formatVal(ev.estimate, ev.unit)}</span>
                </span>
              )}
              {ev.prev !== null && (
                <span>
                  <span className="text-text-muted">Anterior: </span>
                  <span className="text-text-secondary font-num">{formatVal(ev.prev, ev.unit)}</span>
                </span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
