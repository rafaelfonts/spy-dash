import type { EarningsItem } from '../../store/marketStore'
import { Skeleton } from '../ui/Skeleton'

interface Props {
  earnings: EarningsItem[]
  loading: boolean
}

function urgencyClass(days: number | null): string {
  if (days === null) return 'text-text-muted'
  if (days <= 3) return 'text-red-400'
  if (days <= 14) return 'text-[#ffcc00]'
  return 'text-text-secondary'
}

function DaysBadge({ days }: { days: number | null }) {
  if (days === null) return <span className="text-text-muted text-[10px]">—</span>
  const cls =
    days <= 3
      ? 'bg-red-500/15 text-red-400 border-red-500/30'
      : days <= 14
        ? 'bg-[#ffcc00]/10 text-[#ffcc00] border-[#ffcc00]/30'
        : 'bg-bg-base text-text-muted border-border-subtle'
  return (
    <span className={`text-[10px] font-num font-medium px-1.5 py-0.5 rounded border ${cls}`}>
      {days === 0 ? 'HOJE' : days === 1 ? 'AMANHÃ' : `${days}d`}
    </span>
  )
}

export function EarningsCalendar({ earnings, loading }: Props) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    )
  }

  const upcoming = earnings.filter((e) => e.daysToEarnings !== null && e.daysToEarnings >= 0)

  if (upcoming.length === 0) {
    return (
      <p className="text-[11px] text-text-muted text-center py-4">
        Sem earnings próximos (45 dias)
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      {upcoming.map((item) => (
        <div
          key={item.symbol}
          className="flex items-center justify-between py-1 px-2 rounded hover:bg-bg-base/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            {item.daysToEarnings !== null && item.daysToEarnings <= 3 && (
              <span className="text-[10px]">⚠</span>
            )}
            <span className={`text-xs font-mono font-semibold ${urgencyClass(item.daysToEarnings)}`}>
              {item.symbol}
            </span>
            {item.earningsDate && (
              <span className="text-[10px] text-text-muted">
                {new Date(item.earningsDate + 'T12:00:00').toLocaleDateString('pt-BR', {
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
            )}
          </div>
          <DaysBadge days={item.daysToEarnings} />
        </div>
      ))}
    </div>
  )
}
