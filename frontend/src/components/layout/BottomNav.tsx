import type { TabId } from './TabNav'

interface BottomNavProps {
  active: TabId
  onChange: (tab: TabId) => void
}

const TABS: { id: TabId; icon: string; label: string }[] = [
  { id: 'dashboard', icon: '🏠', label: 'Dashboard' },
  { id: 'mercado', icon: '📊', label: 'Mercado' },
  { id: 'macro', icon: '🌍', label: 'Macro' },
  { id: 'portfolio', icon: '💼', label: 'Portfolio' },
]

export function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex justify-around items-center bg-[rgba(10,10,10,0.98)] border-t border-border-subtle pb-safe">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex flex-col items-center gap-[3px] px-4 py-2 text-[8px] font-bold tracking-[0.5px] uppercase font-display transition-colors ${
            active === tab.id ? 'text-[#00ff88]' : 'text-text-muted'
          }`}
        >
          <span className="text-[17px] leading-none">{tab.icon}</span>
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  )
}
