import { useRef, useEffect, useState } from 'react'
import type { NewsHeadline } from '../../store/marketStore'
import { useMarketStore } from '../../store/marketStore'
import { Skeleton } from '../ui/Skeleton'

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `${minutes}min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function NewsHeadlines() {
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollHint, setScrollHint] = useState<string | null>(null)

  const headlines = useMarketStore((s) => s.newsFeed?.headlines ?? [])

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    // Set initial hint if content overflows
    if (el.scrollHeight > el.clientHeight) {
      setScrollHint('↓ role para ver mais matérias')
    } else {
      setScrollHint(null)
    }
    const handler = () => {
      const rem = el.scrollHeight - el.scrollTop - el.clientHeight
      if (rem < 8) setScrollHint('✓ fim das matérias')
      else setScrollHint('↓ role para ver mais matérias')
    }
    el.addEventListener('scroll', handler)
    return () => el.removeEventListener('scroll', handler)
  }, [headlines.length])

  if (headlines.length === 0) {
    return (
      <p className="text-[11px] text-text-muted text-center py-4">
        Aguardando headlines...
      </p>
    )
  }

  return (
    <>
      <div
        ref={listRef}
        className="flex flex-col gap-0 overflow-y-auto"
        style={{ maxHeight: '340px', scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}
      >
        {headlines.map((h: NewsHeadline, idx: number) => (
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
      {scrollHint && (
        <div className="text-center py-[7px] text-[9px] text-text-muted border-t border-border-subtle font-display">
          {scrollHint}
        </div>
      )}
    </>
  )
}
