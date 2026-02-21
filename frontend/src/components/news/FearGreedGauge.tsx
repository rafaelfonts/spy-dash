import type { FearGreedData } from '../../store/marketStore'

interface Props {
  fearGreed: FearGreedData | null
}

// Score zones: 0-24 Extreme Fear, 25-44 Fear, 45-55 Neutral, 56-74 Greed, 75-100 Extreme Greed
function getZone(score: number): { label: string; color: string; bg: string } {
  if (score <= 24) return { label: 'Medo Extremo',  color: '#ff4444', bg: 'rgba(255,68,68,0.1)' }
  if (score <= 44) return { label: 'Medo',           color: '#ff8c42', bg: 'rgba(255,140,66,0.1)' }
  if (score <= 55) return { label: 'Neutro',          color: '#ffcc00', bg: 'rgba(255,204,0,0.1)' }
  if (score <= 74) return { label: 'Ganância',        color: '#88dd44', bg: 'rgba(136,221,68,0.1)' }
  return                { label: 'Ganância Extrema', color: '#00ff88', bg: 'rgba(0,255,136,0.1)' }
}

// SVG arc gauge: semicircle from -180deg to 0deg
function GaugeSVG({ score }: { score: number }) {
  const zone = getZone(score)
  const cx = 60
  const cy = 60
  const r = 48
  const strokeWidth = 10
  const circumference = Math.PI * r  // half circle

  // Background arc (full semicircle)
  const bgPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`
  // Filled arc (progress)
  const fillRatio = score / 100
  const fillLength = fillRatio * circumference
  const fillOffset = circumference - fillLength

  return (
    <svg width="120" height="66" viewBox="0 0 120 66" className="overflow-visible">
      {/* Background track */}
      <path
        d={bgPath}
        fill="none"
        stroke="rgba(255,255,255,0.06)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      {/* Colored fill */}
      <path
        d={bgPath}
        fill="none"
        stroke={zone.color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={`${fillLength} ${circumference}`}
        style={{ filter: `drop-shadow(0 0 4px ${zone.color}60)` }}
      />
      {/* Needle dot */}
      {(() => {
        const angle = Math.PI * fillRatio // 0 = left, PI = right
        const nx = cx - r * Math.cos(angle)
        const ny = cy - r * Math.sin(angle)
        return (
          <circle
            cx={nx}
            cy={ny}
            r={5}
            fill={zone.color}
            style={{ filter: `drop-shadow(0 0 3px ${zone.color})` }}
          />
        )
      })()}
    </svg>
  )
}

export function FearGreedGauge({ fearGreed }: Props) {
  if (!fearGreed || fearGreed.score === null) {
    return (
      <div className="flex flex-col items-center justify-center py-3 gap-1">
        <div className="text-[11px] text-text-muted">Fear & Greed indisponível</div>
        <div className="text-[9px] text-text-muted opacity-60">Endpoint CNN não oficial</div>
      </div>
    )
  }

  const score = fearGreed.score
  const zone = getZone(score)

  return (
    <div className="flex items-center gap-4">
      {/* Gauge SVG */}
      <div className="flex flex-col items-center shrink-0">
        <GaugeSVG score={score} />
        <div
          className="text-xl font-num font-bold -mt-1"
          style={{ color: zone.color }}
        >
          {score}
        </div>
      </div>

      {/* Label + zones legend */}
      <div className="flex-1 min-w-0">
        <div
          className="text-sm font-semibold mb-2"
          style={{ color: zone.color }}
        >
          {zone.label}
        </div>

        <div className="space-y-1">
          {[
            { range: '0–24',  label: 'Medo Extremo',  color: '#ff4444' },
            { range: '25–44', label: 'Medo',           color: '#ff8c42' },
            { range: '45–55', label: 'Neutro',          color: '#ffcc00' },
            { range: '56–74', label: 'Ganância',        color: '#88dd44' },
            { range: '75–100',label: 'Gan. Extrema',   color: '#00ff88' },
          ].map((z) => (
            <div key={z.range} className="flex items-center gap-2">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: score >= parseInt(z.range) ? z.color : 'rgba(255,255,255,0.1)' }}
              />
              <span className="text-[10px] text-text-muted">{z.range}</span>
              <span className="text-[10px]" style={{ color: z.color }}>{z.label}</span>
            </div>
          ))}
        </div>

        {fearGreed.previousClose !== null && (
          <div className="mt-2 text-[9px] text-text-muted">
            Anterior: {fearGreed.previousClose} · Fonte: CNN (não oficial)
          </div>
        )}
      </div>
    </div>
  )
}
