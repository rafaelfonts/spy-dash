export type TabId = 'dashboard' | 'mercado' | 'macro' | 'portfolio'

interface TabNavProps {
  active: TabId
  onChange: (tab: TabId) => void
}

const TABS: { id: TabId; label: string }[] = [
  { id: 'dashboard', label: '🏠 Dashboard' },
  { id: 'mercado', label: '📊 Mercado' },
  { id: 'macro', label: '🌍 Macro & News' },
  { id: 'portfolio', label: '💼 Portfolio' },
]

export function TabNav({ active, onChange }: TabNavProps) {
  return (
    <div className="hidden md:flex border-b border-border-subtle bg-[#0d0d0d]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 flex gap-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`px-5 py-[10px] text-[11px] font-bold tracking-[0.5px] border-b-2 transition-colors font-display whitespace-nowrap ${
              active === tab.id
                ? 'text-[#00ff88] border-[#00ff88]'
                : 'text-text-muted border-transparent hover:text-text-secondary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  )
}
