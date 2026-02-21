import type { MacroDataItem } from '../../store/marketStore'
import { Skeleton } from '../ui/Skeleton'

interface Props {
  macro: MacroDataItem[]
  bls: MacroDataItem[]
  loading: boolean
}

function changeDirection(value: number | null, previous: number | null): 'up' | 'down' | 'flat' {
  if (value === null || previous === null) return 'flat'
  if (value > previous) return 'up'
  if (value < previous) return 'down'
  return 'flat'
}

// FRED series color logic
function fredColor(seriesId: string, value: number | null, previous: number | null): string {
  if (value === null) return 'text-text-muted'
  const dir = changeDirection(value, previous)
  if (seriesId === 'T10Y2Y') {
    return value < 0 ? 'text-red-400' : 'text-[#00ff88]'
  }
  if (['CPIAUCSL', 'CPILFESL', 'PCEPI'].includes(seriesId)) {
    if (dir === 'up') return 'text-red-400'
    if (dir === 'down') return 'text-[#00ff88]'
    return 'text-text-primary'
  }
  return 'text-text-primary'
}

// BLS series color logic
function blsColor(seriesId: string, value: number | null, previous: number | null): string {
  if (value === null) return 'text-text-muted'
  const dir = changeDirection(value, previous)
  // Unemployment: rising = bad
  if (seriesId === 'LNS14000000') {
    if (dir === 'up') return 'text-red-400'
    if (dir === 'down') return 'text-[#00ff88]'
    return 'text-text-primary'
  }
  // Nonfarm Payrolls: rising = good
  if (seriesId === 'CES0000000001') {
    if (dir === 'up') return 'text-[#00ff88]'
    if (dir === 'down') return 'text-red-400'
    return 'text-text-primary'
  }
  // PPI: rising = inflation risk = bad
  if (seriesId === 'WPSFD4') {
    if (dir === 'up') return 'text-red-400'
    if (dir === 'down') return 'text-[#00ff88]'
    return 'text-text-primary'
  }
  return 'text-text-primary'
}

function ArrowIcon({ dir }: { dir: 'up' | 'down' | 'flat' }) {
  if (dir === 'up') return <span className="text-red-400 text-[10px]">▲</span>
  if (dir === 'down') return <span className="text-[#00ff88] text-[10px]">▼</span>
  return <span className="text-text-muted text-[10px]">—</span>
}

function formatFredValue(value: number | null, seriesId: string): string {
  if (value === null) return '—'
  if (seriesId === 'T10Y2Y') {
    const label = value < 0 ? ' inv.' : ''
    return `${value.toFixed(2)}%${label}`
  }
  return `${value.toFixed(2)}%`
}

function formatBlsValue(value: number | null, unit: string): string {
  if (value === null) return '—'
  if (unit === '%') return `${value.toFixed(1)}%`
  if (unit === 'K') return `${value.toLocaleString('en-US')}K`
  if (unit === '$/h') return `$${value.toFixed(2)}`
  // idx: raw index value
  return value.toFixed(1)
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5 mt-3 mb-1.5">
      <span className="text-[9px] font-bold tracking-widest text-text-muted uppercase">{label}</span>
      <span className="flex-1 h-px bg-border-subtle" />
    </div>
  )
}

export function MacroData({ macro, bls, loading }: Props) {
  const hasMacro = macro.length > 0
  const hasBls = bls.length > 0

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    )
  }

  if (!hasMacro && !hasBls) {
    return (
      <p className="text-[11px] text-text-muted text-center py-4">
        Aguardando dados macro...
      </p>
    )
  }

  return (
    <div>
      {hasMacro && (
        <>
          <SectionDivider label="FRED" />
          <div className="space-y-1.5">
            {macro.map((item) => {
              const dir = changeDirection(item.value, item.previousValue)
              const valColor = fredColor(item.seriesId, item.value, item.previousValue)

              return (
                <div
                  key={item.seriesId}
                  className="flex items-center justify-between py-1 px-2 rounded hover:bg-bg-base/50 transition-colors"
                >
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] text-text-secondary truncate">{item.name}</span>
                    {item.date && (
                      <span className="text-[9px] text-text-muted">{item.date}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <ArrowIcon dir={dir} />
                    <span className={`text-xs font-num font-semibold ${valColor}`}>
                      {formatFredValue(item.value, item.seriesId)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {hasBls && (
        <>
          <SectionDivider label="BLS" />
          <div className="space-y-1.5">
            {bls.map((item) => {
              const dir = changeDirection(item.value, item.previousValue)
              const valColor = blsColor(item.seriesId, item.value, item.previousValue)

              return (
                <div
                  key={item.seriesId}
                  className="flex items-center justify-between py-1 px-2 rounded hover:bg-bg-base/50 transition-colors"
                >
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] text-text-secondary truncate">{item.name}</span>
                    {item.date && (
                      <span className="text-[9px] text-text-muted">{item.date}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <ArrowIcon dir={dir} />
                    <span className={`text-xs font-num font-semibold ${valColor}`}>
                      {formatBlsValue(item.value, item.unit)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
