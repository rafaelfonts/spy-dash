export function fmtPrice(value: number | null | undefined, decimals = 2): string {
  if (value == null || !isFinite(value)) return '—'
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

export function fmtChange(value: number | null | undefined, decimals = 2): string {
  if (value == null || !isFinite(value)) return '—'
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(decimals)}`
}

export function fmtPct(value: number | null | undefined, decimals = 2): string {
  if (value == null || !isFinite(value)) return '—'
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(decimals)}%`
}

export function fmtVolume(value: number | null | undefined): string {
  if (value == null || !isFinite(value)) return '—'
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`
  return value.toString()
}

export function fmtSpread(bid: number | null, ask: number | null): string {
  if (bid == null || ask == null) return '—'
  return `${fmtPrice(bid)} / ${fmtPrice(ask)}`
}

export function isUp(change: number | null | undefined): boolean {
  return change !== null && change !== undefined && change > 0
}

export function isDown(change: number | null | undefined): boolean {
  return change !== null && change !== undefined && change < 0
}

export function changeClass(change: number | null | undefined): string {
  if (isUp(change)) return 'text-up'
  if (isDown(change)) return 'text-down'
  return 'text-neutral'
}
