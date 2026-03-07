/**
 * VolSurfaceChart — Vol surface grid (skew by DTE).
 *
 * Displays a 2D table: rows = metrics (IV ATM, RR25, Put Slope),
 * columns = DTE buckets (0DTE / 7D / 21D / 45D).
 * Cells are color-coded by value magnitude.
 */

import { useMarketStore } from '../../store/marketStore'
import type { SkewEntry } from '../../store/marketStore'

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

const SKEW_LABEL_COLORS: Record<SkewEntry['skewLabel'], string> = {
  steep:    '#ff4444',
  normal:   '#00ff88',
  flat:     '#ffcc00',
  inverted: '#ff8800',
}

/** Color for IV ATM value: green if low (<20), yellow if moderate, red if high (>35) */
function ivAtmColor(v: number | null): string {
  if (v === null) return '#555'
  if (v < 20) return '#00ff88'
  if (v < 35) return '#ffcc00'
  return '#ff4444'
}

/** Color for Risk Reversal (negative = put skew dominant = normal; positive = unusual) */
function rrColor(v: number | null): string {
  if (v === null) return '#555'
  if (v < -3) return '#ff4444'   // steep put skew
  if (v < -1) return '#ffcc00'   // moderate
  if (v < 1)  return '#888888'   // flat / near zero
  return '#00ff88'               // unusual: call skew dominant
}

/** Color for put slope: higher slope = more expensive downside protection */
function slopeColor(v: number | null): string {
  if (v === null) return '#555'
  if (v > 3)  return '#ff4444'
  if (v > 1)  return '#ffcc00'
  return '#888888'
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function HeaderCell({ label }: { label: string }) {
  return (
    <div className="text-[10px] font-semibold text-text-muted text-center py-1 px-2">
      {label}
    </div>
  )
}

function MetricLabel({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="text-[10px] text-text-muted pr-2 flex flex-col justify-center">
      <span className="font-semibold">{label}</span>
      {sub && <span className="text-[9px] opacity-60">{sub}</span>}
    </div>
  )
}

function ValueCell({
  value,
  color,
  suffix = '',
  placeholder = '—',
}: {
  value: number | null
  color: string
  suffix?: string
  placeholder?: string
}) {
  return (
    <div
      className="text-[11px] font-mono font-semibold text-center py-1.5 px-1 rounded"
      style={
        value !== null
          ? { color, background: `${color}12`, border: `1px solid ${color}25` }
          : { color: '#444', border: '1px solid #2a2a2a' }
      }
    >
      {value !== null ? `${value > 0 ? '+' : ''}${value.toFixed(1)}${suffix}` : placeholder}
    </div>
  )
}

function SkewLabelCell({ entry }: { entry: SkewEntry | null }) {
  if (!entry) {
    return (
      <div className="text-[10px] text-center py-1 text-text-muted opacity-40">—</div>
    )
  }
  const color = SKEW_LABEL_COLORS[entry.skewLabel]
  return (
    <div
      className="text-[10px] font-semibold text-center py-1 px-1 rounded capitalize"
      style={{ color, background: `${color}15`, border: `1px solid ${color}30` }}
    >
      {entry.skewLabel}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DTE column header with expiration date
// ---------------------------------------------------------------------------

function DTEHeader({ label, entry }: { label: string; entry: SkewEntry | null }) {
  return (
    <div className="text-center">
      <div className="text-[10px] font-semibold text-white">{label}</div>
      {entry && (
        <div className="text-[9px] text-text-muted opacity-60">{entry.expiration}</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function VolSurfaceChart() {
  const skewByDTE = useMarketStore((s) => s.skewByDTE)

  if (!skewByDTE) return null

  const { dte0, dte7, dte21, dte45 } = skewByDTE

  // At least one bucket must have data
  if (!dte0 && !dte7 && !dte21 && !dte45) return null

  const cols: Array<{ label: string; entry: SkewEntry | null }> = [
    { label: '0DTE', entry: dte0  },
    { label: '7D',   entry: dte7  },
    { label: '21D',  entry: dte21 },
    { label: '45D',  entry: dte45 },
  ]

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-3">
        Vol Surface — Skew por DTE
      </div>

      {/* Grid: 5 cols (label + 4 DTE) */}
      <div className="grid gap-1" style={{ gridTemplateColumns: 'auto repeat(4, 1fr)' }}>

        {/* Header row */}
        <div />
        {cols.map(({ label, entry }) => (
          <HeaderCell key={label} label="" />
        ))}

        {/* DTE headers with expiration */}
        <div />
        {cols.map(({ label, entry }) => (
          <DTEHeader key={label} label={label} entry={entry} />
        ))}

        {/* Divider */}
        <div className="col-span-5 h-px bg-border my-1" />

        {/* IV ATM row */}
        <MetricLabel label="IV ATM" sub="%" />
        {cols.map(({ label, entry }) => (
          <ValueCell
            key={label}
            value={entry ? entry.ivAtm : null}
            color={ivAtmColor(entry?.ivAtm ?? null)}
            suffix="%"
          />
        ))}

        {/* Risk Reversal 25d row */}
        <MetricLabel label="RR 25d" sub="put−call" />
        {cols.map(({ label, entry }) => (
          <ValueCell
            key={label}
            value={entry ? entry.riskReversal25 : null}
            color={rrColor(entry?.riskReversal25 ?? null)}
            suffix="%"
          />
        ))}

        {/* Put Slope row */}
        <MetricLabel label="Put Slope" sub="25d−10d" />
        {cols.map(({ label, entry }) => (
          <ValueCell
            key={label}
            value={entry ? entry.putSkewSlope : null}
            color={slopeColor(entry?.putSkewSlope ?? null)}
            suffix="%"
          />
        ))}

        {/* Divider */}
        <div className="col-span-5 h-px bg-border my-1" />

        {/* Skew label row */}
        <MetricLabel label="Skew" />
        {cols.map(({ label, entry }) => (
          <SkewLabelCell key={label} entry={entry} />
        ))}
      </div>

      {/* Legend */}
      <div className="flex gap-3 mt-2 flex-wrap">
        {Object.entries(SKEW_LABEL_COLORS).map(([label, color]) => (
          <span key={label} className="flex items-center gap-1 text-[9px]" style={{ color }}>
            <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: color }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
