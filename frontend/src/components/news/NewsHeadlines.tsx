import type { NewsHeadline } from '../../store/marketStore'
import { Skeleton } from '../ui/Skeleton'

interface Props {
  headlines: NewsHeadline[]
  loading: boolean
}

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `${minutes}min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function NewsHeadlines({ headlines, loading }: Props) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  if (headlines.length === 0) {
    return (
      <p className="text-[11px] text-text-muted text-center py-4">
        Aguardando headlines...
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      {headlines.map((h, idx) => (
        <a
          key={idx}
          href={h.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block p-2 rounded border border-border-subtle hover:border-border hover:bg-bg-base/50 transition-colors group"
        >
          <p className="text-xs text-text-primary leading-snug group-hover:text-[#00ff88] transition-colors line-clamp-2">
            {h.title}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] text-text-muted">{h.source}</span>
            <span className="text-[10px] text-text-muted opacity-50">·</span>
            <span className="text-[10px] text-text-muted">{timeAgo(h.publishedAt)}</span>
          </div>
        </a>
      ))}
    </div>
  )
}
