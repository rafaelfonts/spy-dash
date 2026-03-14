import { useMarketStore } from '../../store/marketStore'

const ZONES = [
  { min: 0, max: 24, label: 'Medo Extremo', color: '#ff4444' },
  { min: 25, max: 44, label: 'Medo', color: '#ff8800' },
  { min: 45, max: 55, label: 'Neutro', color: '#ffcc00' },
  { min: 56, max: 74, label: 'Ganância', color: '#88dd44' },
  { min: 75, max: 100, label: 'Gan. Extrema', color: '#00ff88' },
]

function getZone(score: number) {
  return ZONES.find((z) => score >= z.min && score <= z.max) ?? ZONES[2]
}

export function FearGreedGauge() {
  const fearGreed = useMarketStore((s) => s.newsFeed?.fearGreed)

  if (!fearGreed || fearGreed.score === null) {
    return (
      <div className="rounded-lg border border-border-subtle bg-bg-card p-4">
        <div className="text-[9px] text-text-muted uppercase tracking-[1.5px] font-display font-bold mb-3">
          Sentimento do Mercado
        </div>
        <div className="text-text-muted text-sm">—</div>
      </div>
    )
  }

  const score = fearGreed.score
  const zone = getZone(score)

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card p-4 flex flex-col gap-3">
      {/* Section label + badge */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-text-muted uppercase tracking-[1.5px] font-display font-bold">
          Sentimento do Mercado
        </span>
        <span
          className="text-[8px] font-bold px-[6px] py-[2px] rounded font-display"
          style={{
            background: zone.color + '22',
            color: zone.color,
            border: `1px solid ${zone.color}44`,
          }}
        >
          {zone.label}
        </span>
        <div className="flex-1 h-px bg-border-subtle" />
      </div>

      {/* Score + label */}
      <div className="flex items-center gap-4">
        <span
          className="text-[56px] font-bold leading-none font-mono"
          style={{ color: zone.color }}
        >
          {score}
        </span>
        <div>
          <div
            className="text-[17px] font-bold font-display"
            style={{ color: zone.color }}
          >
            {zone.label}
          </div>
          <div className="text-[10px] text-text-muted font-display mt-1">
            {fearGreed.previousClose != null
              ? `Anterior: ${fearGreed.previousClose} · Fonte: CNN`
              : 'Fonte: CNN'}
          </div>
        </div>
      </div>

      {/* Gradient bar with needle */}
      <div>
        <div
          className="relative h-2 rounded-full"
          style={{
            background:
              'linear-gradient(to right, #ff2222, #ff6600 20%, #ffcc00 40%, #88dd44 60%, #00ff88)',
          }}
        >
          <div
            className="absolute top-[-4px] w-[2px] h-4 rounded-sm bg-white"
            style={{
              left: `${Math.min(98, Math.max(2, score))}%`,
              transform: 'translateX(-50%)',
              boxShadow: '0 0 6px rgba(255,255,255,0.5)',
            }}
          />
        </div>
        <div className="flex justify-between mt-1 text-[8px] text-text-muted font-mono">
          <span>0</span>
          <span>25</span>
          <span>45</span>
          <span>56</span>
          <span>75</span>
          <span>100</span>
        </div>
      </div>

      {/* Zone chips */}
      <div className="grid grid-cols-5 gap-1">
        {ZONES.map((z) => {
          const isActive = score >= z.min && score <= z.max
          return (
            <div
              key={z.label}
              className="py-[5px] text-center text-[8px] font-bold rounded font-display leading-tight"
              style={{
                background: z.color + '22',
                color: z.color,
                opacity: isActive ? 1 : 0.2,
              }}
            >
              {z.label}
            </div>
          )
        })}
      </div>
    </div>
  )
}
